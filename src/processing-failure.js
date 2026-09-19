const FIELD = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_MESSAGE_LENGTH = 300;

function boundedMessage(value) {
  const clean = String(value || 'Inbound processing failed').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?');
  let result = clean.slice(0, MAX_MESSAGE_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result || 'Inbound processing failed';
}

export class ProcessingFailure extends Error {
  constructor(stage, code, message) {
    super(message);
    this.name = 'VkWorkspaceProcessingFailure';
    this.stage = stage;
    this.code = code;
  }
}

export function safeFailure(error, fallbackStage = 'dispatch') {
  fallbackStage = typeof fallbackStage === 'string' && FIELD.test(fallbackStage) ? fallbackStage : 'dispatch';
  if (error instanceof ProcessingFailure) {
    return { stage: typeof error.stage === 'string' && FIELD.test(error.stage) ? error.stage : fallbackStage,
      code: typeof error.code === 'string' && FIELD.test(error.code) ? error.code : 'unexpected', message: boundedMessage(error.message) };
  }
  return { stage: fallbackStage, code: 'unexpected',
    message: 'Inbound processing failed; inspect Gateway provider logs for the matching event' };
}

export function validFailure(value) {
  return value === undefined || Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.stage === 'string' && FIELD.test(value.stage) && typeof value.code === 'string' && FIELD.test(value.code) && typeof value.message === 'string' && value.message.length > 0 &&
    value.message.length <= MAX_MESSAGE_LENGTH && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.message));
}
