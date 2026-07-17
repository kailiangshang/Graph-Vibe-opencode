import { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, E, R>(self: Effect.Effect<A, StorageNotFoundError | E, R>) {
  return self.pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, E, R>(self: Effect.Effect<A, Session.BusyError | E, R>) {
  return self.pipe(
    Effect.catchIf(
      (error): error is Session.BusyError => error instanceof Session.BusyError,
      (error) =>
        Effect.fail(
          new ApiError.SessionBusyError({
            sessionID: error.sessionID,
            message: `Session is busy: ${error.sessionID}`,
          }),
        ),
    ),
  )
}
