/**
 * State files: how the Controller's stores put their state on disk.
 *
 * Contract. A store never opens a file itself. It is given a `StateFileWriter` and calls it with the final path and the complete content; the writer
 * replaces the file whole (a reader sees the old content or the new, never a part), or rejects. The Controller process supplies the Node
 * implementation; a test supplies a recording one.
 */
export type StateFileWriter = (path: string, content: string) => Promise<void>;
