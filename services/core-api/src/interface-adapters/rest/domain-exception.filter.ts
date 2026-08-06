import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import {
  DomainError,
  DuplicateUserException,
  EntityNotFoundException,
  InvalidArgumentException,
  InvalidCredentialsException,
  InvalidStateTransitionException,
  InvalidValueObjectException,
  SystemNotConfiguredException,
} from '../../domain/shared';

/**
 * Maps domain {@link DomainError}s to HTTP responses so the application layer
 * stays free of HTTP concerns (DIP / NFR-MNT-01). Registered globally in
 * `main.ts`. Only acts on the HTTP transport; non-HTTP hosts (the WebSocket
 * gateway) are left to Nest's default handling, since queue-control domain
 * errors today originate only from REST use cases.
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // Not an HTTP request — rethrow so Nest's default handling applies.
      throw exception;
    }
    const response = host.switchToHttp().getResponse();
    const status = this.statusFor(exception);
    response.status(status).json({
      statusCode: status,
      code: exception.code,
      error: exception.name,
      message: exception.message,
    });
  }

  private statusFor(exception: DomainError): number {
    if (exception instanceof EntityNotFoundException) {
      return HttpStatus.NOT_FOUND;
    }
    if (exception instanceof InvalidCredentialsException) {
      return HttpStatus.UNAUTHORIZED;
    }
    if (exception instanceof InvalidStateTransitionException) {
      return HttpStatus.CONFLICT;
    }
    if (exception instanceof SystemNotConfiguredException) {
      return HttpStatus.CONFLICT;
    }
    if (exception instanceof DuplicateUserException) {
      return HttpStatus.CONFLICT;
    }
    if (exception instanceof InvalidValueObjectException) {
      return HttpStatus.BAD_REQUEST;
    }
    if (exception instanceof InvalidArgumentException) {
      return HttpStatus.BAD_REQUEST;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}