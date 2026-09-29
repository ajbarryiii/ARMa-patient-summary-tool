"use strict";

function fileMenuItems({ movable, directory, canCreate, busy, revealLabel }) {
  return [
    { id: "rename", label: "Rename…", enabled: movable && !busy },
    { id: "move", label: "Move to…", enabled: movable && !busy },
    ...(directory ? [{ id: "new-folder", label: "New folder…", enabled: canCreate && !busy }] : []),
    { type: "separator" },
    { id: "reveal", label: revealLabel },
  ];
}

function editMenuItems({ editable, selection, flags = {} }) {
  if (!editable && !selection) return [];
  const allowed = (flag) => flags[flag] !== false;
  return [
    ...(editable ? [
      { role: "undo", enabled: allowed("canUndo") },
      { role: "redo", enabled: allowed("canRedo") },
      { type: "separator" },
      { role: "cut", enabled: selection && allowed("canCut") },
    ] : []),
    { role: "copy", enabled: selection && allowed("canCopy") },
    ...(editable ? [{ role: "paste", enabled: allowed("canPaste") }] : []),
    { type: "separator" },
    { role: "selectAll", enabled: allowed("canSelectAll") },
  ];
}

module.exports = { fileMenuItems, editMenuItems };
