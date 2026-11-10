/** An upload the transfer queue has finished: its id and where the file now is on the server. */
export interface FinishedUpload {
  id: number;
  remote: string;
}

/**
 * Whether any of the uploads put something in `dir` or in a folder under it, which changes what
 * the listing of `dir` shows: a new file, a new folder, or the final size of one that was growing.
 */
export function landedIn(dir: string, uploads: readonly FinishedUpload[]): boolean {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return uploads.some((upload) => upload.remote.startsWith(prefix));
}
