'use strict';

// 领域错误：带 HTTP 语义，便于入口层映射状态码
class DomainError extends Error {
  constructor(message, code = 'DOMAIN_ERROR', status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

const errors = {
  validation: (msg) => new DomainError(msg, 'VALIDATION_ERROR', 400),
  conflict: (msg, code = 'CONFLICT') => new DomainError(msg, code, 409),
  notFound: (msg = '未找到') => new DomainError(msg, 'NOT_FOUND', 404),
  interval: (msg) => new DomainError(msg, 'RETEST_INTERVAL_NOT_MET', 409),
};

module.exports = { DomainError, errors };
