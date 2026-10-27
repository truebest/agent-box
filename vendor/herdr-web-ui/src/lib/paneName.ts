/**
 * A pane is known by its project, not by where it sits on disk. A shell's terminal title is
 * usually its working directory written out ("/home/me/dev/api", "~/dev/api", "C:\\work\\api"):
 * shown whole, it is cut off long before the part that tells panes apart. Such a title shows as
 * its last folder; the full path stays in the row's tooltip. Any other title is left alone.
 */
const PATH_TITLE = /^(?:~(?=$|[\\/])|\/|[A-Za-z]:[\\/])/;

export function shortPathTitle(title: string): string {
  const trimmed = title.trim();
  return PATH_TITLE.test(trimmed) ? folderName(trimmed) : title;
}

/** A path's last folder, split on either platform's separator: "C:\\work\\api" is "api" as "/work/api" is. */
export function folderName(path: string): string {
  const last = path.split(/[\\/]+/).filter((part) => part !== "").at(-1);
  if (last === undefined) return path; // "/" itself
  // a drive root keeps the separator it was written with, so it still reads as a place
  return /^[A-Za-z]:$/.test(last) ? `${last}${path[2] ?? "\\"}` : last;
}

/**
 * A roster row drawn on two lines: what its pane is doing, and where under it. A shell's title
 * is often just its folder, which says nothing a workspace's name does not say better, so that
 * row leads with the workspace and keeps the second line for what is left to say.
 */
export function taskRowLines({ paneTitle, labelled, folder, workspace, alias }: {
  /** the pane's title as the roster shows it */
  paneTitle: string;
  /** the user named the pane: the name is kept as it is */
  labelled: boolean;
  /** the last folder of the pane's working directory */
  folder: string;
  /** the workspace's row name: its label, which herdr makes from the branch until its owner names it */
  workspace: string;
  /** a linked worktree's branch, when the label does not already say it */
  alias?: string | null;
}): { title: string; place: string } {
  const title = !labelled && paneTitle === folder ? workspace : paneTitle;
  const where = [workspace === title ? "" : workspace, alias && alias !== title && alias !== workspace ? alias : ""].filter(Boolean).join(" · ");
  const said = folder === title || folder === workspace || folder === alias;
  return { title, place: placeLine(where, said ? "" : folder) };
}

/** "workspace · folder", without saying the same name twice. */
export function placeLine(workspace: string, folder: string): string {
  return !folder || folder === workspace ? workspace : !workspace ? folder : `${workspace} · ${folder}`;
}
