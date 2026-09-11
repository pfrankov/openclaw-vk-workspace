const FIELD = /^[a-z][a-z0-9-]{0,63}$/;

export class ProcessingFailure extends Error {
  constructor(stage, code, message) {
    super(message);
    this.name = 'VkWorkspaceProcessingFailure';
    this.stage = stage;
    this.code = code;
  }
}

export function safeFailure(error, fallbackStage = 'dispatch') {
  if (error instanceof ProcessingFailure) {
    return { stage: error.stage, code: error.code, message: error.message };
  }
  return { stage: fallbackStage, code: 'unexpected',
    message: 'Inbound processing failed; inspect Gateway provider logs for the matching event' };
}

export function validFailure(value) {
  return value === undefined || Boolean(value && typeof value === 'object' && FIELD.test(value.stage) &&
    FIELD.test(value.code) && typeof value.message === 'string' && value.message.length > 0 &&
    value.message.length <= 300 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.message));
}
