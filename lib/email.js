import { trace, SpanStatusCode } from '@opentelemetry/api';
import { sendAlert as baseSendAlert } from '../email.mjs';

const tracer = trace.getTracer('boom-sla-check');

export async function sendAlert(payload) {
  return tracer.startActiveSpan('alert.send', async (span) => {
    try {
      if (payload?.subject) {
        span.setAttribute('alert.subject', String(payload.subject));
      }
      const result = await baseSendAlert(payload);
      return result;
    } catch (error) {
      span.recordException?.(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message || String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
