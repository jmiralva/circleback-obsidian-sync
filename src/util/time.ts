// Meeting times. Circleback sends UTC timestamps; everything the user sees (file names,
// folders, daily-note dates and link times) is in the local time zone of the device.
import { moment } from "obsidian";

/** A `moment` instance. Obsidian's typings do not name the type, so it is taken from its own function. */
export type Moment = ReturnType<typeof moment.utc>;

/**
 * Turns a UTC ISO timestamp into the same instant in local time.
 *
 * Reads anything `Date` can read, which is the same test the API schemas apply, so a
 * timestamp that passed validation never gives an invalid result. A string `Date` cannot
 * read gives an invalid moment (`isValid()` is false) rather than throwing.
 */
export function meetingLocal(isoStart: string): Moment {
  // `moment(...)` itself is not callable through Obsidian's typings under `esModuleInterop`,
  // but `moment.utc(...)` is, and `.local()` switches the same instant to local time.
  return moment.utc(new Date(isoStart)).local();
}
