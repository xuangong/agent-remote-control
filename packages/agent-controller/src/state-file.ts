/**
 * State files: how the Controller's stores put their state on disk.
 *
 * Contract. A store never opens a file itself. It is given a `StateFileWriter` and calls it with the final path and the complete content; the writer
 * replaces the file whole (a reader sees the old content or the new, never a part), or rejects. The Controller process supplies the Node
 * implementation; a test supplies a recording one.
 */
export type StateFileWriter = (path: string, content: string) => Promise<void>;

/**
 * The named files of one state directory, for a store that reads its own file back or keeps one file per record.
 *
 * Contract. `open` makes the directory usable and is called once before any other method. `list` returns the file names. `read` returns the
 * text of a file, or `undefined` when there is none. `publish` replaces a file whole and durably: a reader sees the old content or the new,
 * and a resolved call means the content survives a crash. A rejected call has left the old content in place; a store that needs to tell that
 * from an unknown outcome reads the error class (`SuccessionPublicationRejected`, `SuccessionPublicationUnknown`). The disk implementation is
 * `diskStateFiles` (`succession-persistence.ts`); `memoryStateFiles` (`./testing`) keeps the files in a map.
 */
export interface StateFiles {
  open(): Promise<void>;
  list(): Promise<string[]>;
  read(name: string): Promise<string | undefined>;
  publish(name: string, content: string): Promise<void>;
}
