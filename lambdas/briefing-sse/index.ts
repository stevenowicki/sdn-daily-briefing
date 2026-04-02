/**
 * briefing-sse/index.ts
 *
 * Lambda with response streaming — serves a Server-Sent Events (SSE) endpoint.
 * Invoked via Lambda Function URL (streaming mode), proxied through CloudFront
 * at the path /sse.
 *
 * Protocol:
 *   - On connect: sends ": connected\n\n" SSE comment
 *   - Every 25 seconds: sends ": heartbeat\n\n" SSE comment (keeps proxies happy)
 *   - Every 15 seconds: HEAD s3://{bucket}/manifest.json and compare ETag
 *   - When ETag changes: sends "data: {"type":"new-briefing"}\n\n", then closes
 *   - After 13 minutes: closes naturally (client auto-reconnects via SSE spec)
 *
 * Scale considerations:
 *   Each connected client = one concurrent Lambda invocation.
 *   This scales comfortably to ~500-1000 concurrent users (Lambda default
 *   concurrency limit). Beyond that you would move to one of:
 *
 *   A) AWS IoT Core + MQTT over WebSocket — purpose-built for browser pub/sub,
 *      scales to billions of connections, $0.08/million device-minutes.
 *      Requires Cognito Identity Pools for browser credentials.
 *
 *   B) ECS Fargate + Redis Pub/Sub — persistent servers that broadcast to all
 *      connected clients; CloudFront → ALB → ECS cluster.
 *      No per-connection Lambda limit; horizontal scaling via Auto Scaling.
 *
 * Why S3 ETag polling (not SNS/SQS/DynamoDB)?
 *   The generator Lambda already writes manifest.json to S3, and the ETag
 *   changes with each write. Polling S3 HeadObject every 15 seconds is:
 *   - $0.0004 per 1,000 requests (essentially free at this scale)
 *   - No additional signal infrastructure required
 *   - Zero latency between S3 write and detection (max 15s delay)
 *
 * awslambda global:
 *   The `awslambda` namespace is injected by the Lambda Node.js 22 runtime
 *   when InvokeMode is RESPONSE_STREAM. It is not a module you import.
 */

import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// Runtime global — injected by Lambda when InvokeMode = RESPONSE_STREAM
// ---------------------------------------------------------------------------
declare const awslambda: {
  streamifyResponse(
    handler: (event: unknown, responseStream: ResponseStream) => Promise<void>
  ): unknown;
  HttpResponseStream: {
    from(
      stream: ResponseStream,
      metadata: { statusCode: number; headers: Record<string, string> }
    ): ResponseStream;
  };
};

interface ResponseStream extends NodeJS.WritableStream {
  // Lambda streaming response stream
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const BUCKET = process.env.BRIEFINGS_BUCKET_NAME!;

const HEARTBEAT_MS = 25_000;   // Keep proxies and clients alive
const POLL_MS      = 15_000;   // S3 HeadObject interval
const MAX_AGE_MS   = 13 * 60 * 1000;  // 13 min — safely under 14-min Lambda timeout

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getManifestETag(): Promise<string | undefined> {
  const res = await s3.send(new HeadObjectCommand({
    Bucket: BUCKET,
    Key: 'manifest.json',
  }));
  return res.ETag;
}

// ---------------------------------------------------------------------------
// SSE handler (streaming)
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = (awslambda as any).streamifyResponse(async (
  _event: unknown,
  rawStream: ResponseStream,
): Promise<void> => {
  // Wrap the raw stream with HTTP metadata.
  // Headers here are the actual HTTP response headers seen by CloudFront/client.
  const stream = awslambda.HttpResponseStream.from(rawStream, {
    statusCode: 200,
    headers: {
      'Content-Type':  'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',  // Prevents nginx/CloudFront from buffering chunks
    },
  });

  // Announce connection
  stream.write(': connected\n\n');

  // Snapshot the ETag at connection time — any later change = new briefing
  let lastETag: string | undefined;
  try {
    lastETag = await getManifestETag();
    console.log(`[sse] Connected. Initial ETag: ${lastETag}`);
  } catch (err) {
    console.error('[sse] Failed to read initial ETag — closing:', err);
    stream.end();
    return;
  }

  const startTime      = Date.now();
  let lastHeartbeat    = Date.now();
  let lastPoll         = Date.now();

  // Main loop: tick every second, act on intervals
  while (Date.now() - startTime < MAX_AGE_MS) {
    await sleep(1_000);
    const now = Date.now();

    // ── Heartbeat ──────────────────────────────────────────────────────────
    // SSE comment lines (": ...") are invisible to the client's message
    // handler but keep the TCP connection and any intermediate proxies alive.
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      stream.write(': heartbeat\n\n');
      lastHeartbeat = now;
    }

    // ── Poll S3 for new briefing ───────────────────────────────────────────
    if (now - lastPoll >= POLL_MS) {
      lastPoll = now;
      try {
        const currentETag = await getManifestETag();
        if (currentETag && currentETag !== lastETag) {
          console.log(`[sse] ETag changed: ${lastETag} → ${currentETag}`);
          lastETag = currentETag;

          // data: lines are dispatched as MessageEvent in the browser
          stream.write('data: {"type":"new-briefing"}\n\n');

          // Small delay so the chunk flushes before we end the stream
          await sleep(500);
          break;  // Close; EventSource auto-reconnects per spec
        }
      } catch (err) {
        // Transient S3 errors shouldn't kill the connection
        console.error('[sse] Poll error (continuing):', err);
      }
    }
  }

  console.log('[sse] Closing connection (cycle complete or briefing sent)');
  stream.end();
});
