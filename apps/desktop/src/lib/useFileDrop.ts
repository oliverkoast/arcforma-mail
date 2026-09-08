import { useCallback, useRef, useState, type DragEvent } from "react";
import { pathsForFiles } from "../bridge";

/**
 * Drag a file onto the compose and it is attached. There is no button for this any more: the
 * gesture is the whole interface, and a button beside it was a second way to do one thing.
 *
 * Only real files count. Text, links and images dragged out of a web page carry no path and are
 * ignored, so the box does not light up for them and nothing half-attaches. The depth counter is
 * because dragenter and dragleave fire for every child the pointer crosses; without it the
 * highlight flickers off each time the drag passes over the editor.
 */
export function useFileDrop(onPaths: (paths: string[]) => void): {
  dropping: boolean;
  props: { onDragEnter: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
} {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDropping(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDropping(false);
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDropping(false);
      const paths = pathsForFiles(Array.from(e.dataTransfer.files));
      if (paths.length > 0) onPaths(paths);
    },
    [onPaths],
  );
  return { dropping, props: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
