const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (label, text, action) => {
  const element = node("button", "viewer-button", text);
  element.type = "button";
  element.title = label;
  element.setAttribute("aria-label", label);
  element.onclick = action;
  return element;
};
function select(label, entries, value, action) {
  const element = node("select", "viewer-select");
  element.setAttribute("aria-label", label);
  for (const [id, text] of entries) {
    const option = node("option", "", text);
    option.value = id;
    element.append(option);
  }
  element.value = value;
  element.onchange = () => action(element.value);
  return element;
}
function columnName(value) {
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function spreadsheetViewer(container, file) {
  const filePath = file.path,
    fileRevision = file.revision;
  let workbook = file.workbook,
    disposed = false,
    sheetRequest = 0;
  const root = node("div", "spreadsheet-viewer");
  const toolbar = node("div", "viewer-toolbar");
  const location = node("input", "sheet-location");
  location.setAttribute("aria-label", "Go to cell");
  location.placeholder = "A1";
  location.value = "A1";
  const value = node("input", "sheet-formula");
  value.readOnly = true;
  value.setAttribute("aria-label", "Cell value or formula");
  const viewport = node("div", "sheet-viewport");
  const navigation = node("div", "viewer-toolbar sheet-navigation");
  const tabs = node("div", "sheet-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Worksheets");
  let sheetIndex =
      workbook.activeSheet ??
      Math.max(
        0,
        workbook.sheets.findIndex((sheet) => !sheet.hidden),
      ),
    startRow = 1,
    startColumn = 1,
    zoom = 1,
    showHidden = false;
  const rowPage = 200,
    colPage = 50;
  const rowPrev = button("Previous rows", "↑", () => {
    startRow = Math.max(1, startRow - rowPage);
    render();
  });
  const rowNext = button("Next rows", "↓", () => {
    startRow += rowPage;
    render();
  });
  const colPrev = button("Previous columns", "←", () => {
    startColumn = Math.max(1, startColumn - colPage);
    render();
  });
  const colNext = button("Next columns", "→", () => {
    startColumn += colPage;
    render();
  });
  const rangeLabel = node("span", "sheet-range");
  const zoomSelect = select(
    "Spreadsheet zoom",
    [
      ["0.5", "50%"],
      ["0.75", "75%"],
      ["1", "100%"],
      ["1.25", "125%"],
      ["1.5", "150%"],
      ["2", "200%"],
    ],
    "1",
    (next) => {
      zoom = Number(next);
      render();
    },
  );
  const hidden = button(
    "Show hidden rows, columns and sheets",
    "Show hidden",
    () => {
      showHidden = !showHidden;
      hidden.classList.toggle("active", showHidden);
      hidden.setAttribute("aria-pressed", String(showHidden));
      render();
    },
  );
  hidden.setAttribute("aria-pressed", "false");
  toolbar.append(location, value, zoomSelect);
  navigation.append(rowPrev, rowNext, colPrev, colNext, rangeLabel, hidden);
  root.append(toolbar, navigation, viewport, tabs);
  const details = node("details", "viewer-notes");
  root.append(details);
  function renderNotes() {
    details.replaceChildren();
    details.hidden = !workbook.warnings.length;
    details.append(node("summary", "", "Preview notes"));
    for (const warning of workbook.warnings)
      details.append(node("p", "", warning));
  }
  renderNotes();
  container.replaceChildren(root);
  async function chooseSheet(index) {
    const request = ++sheetRequest;
    const controls = [
      location,
      zoomSelect,
      hidden,
      rowPrev,
      rowNext,
      colPrev,
      colNext,
    ];
    try {
      if (workbook.lazySheets && !workbook.sheets[index].cells) {
        controls.forEach((control) => {
          control.disabled = true;
        });
        root.setAttribute("aria-busy", "true");
        viewport.replaceChildren(
          node("p", "viewer-message", "Loading worksheet…"),
        );
        const next = await window.arma.preview(filePath, index);
        if (disposed || request !== sheetRequest) return;
        if (next.revision !== fileRevision)
          throw new Error("This workbook changed. Reopen its preview.");
        workbook = next.workbook;
        renderNotes();
      }
      sheetIndex = index;
      startRow = startColumn = 1;
      location.value = "A1";
      value.value = "";
      controls.forEach((control) => {
        control.disabled = false;
      });
      render();
    } catch (error) {
      if (disposed || request !== sheetRequest) return;
      viewport.replaceChildren(node("p", "viewer-message", error.message));
    } finally {
      if (!disposed && request === sheetRequest)
        root.setAttribute("aria-busy", "false");
    }
  }
  function chooseCell(row, col, cell) {
    root.querySelector(".sheet-cell.selected")?.classList.remove("selected");
    cell?.classList.add("selected");
    location.value = `${columnName(col)}${row}`;
    const data = workbook.sheets[sheetIndex].cells[`${row}:${col}`];
    value.value = data?.formula ? `=${data.formula}` : data?.text || "";
  }
  location.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    const match = location.value
      .trim()
      .toUpperCase()
      .match(/^([A-Z]{1,3})([1-9]\d*)$/);
    const sheet = workbook.sheets[sheetIndex];
    if (!match) {
      location.setCustomValidity("Enter a cell address, such as B24.");
      location.reportValidity();
      return;
    }
    const col = [...match[1]].reduce(
        (result, letter) => result * 26 + letter.charCodeAt(0) - 64,
        0,
      ),
      row = Number(match[2]);
    if (row > sheet.rowCount || col > sheet.columnCount) {
      location.setCustomValidity("That cell is outside the used sheet range.");
      location.reportValidity();
      return;
    }
    location.setCustomValidity("");
    startRow = Math.floor((row - 1) / rowPage) * rowPage + 1;
    startColumn = Math.floor((col - 1) / colPage) * colPage + 1;
    render();
    const cell = viewport.querySelector(`[data-cell="${match[1]}${row}"]`);
    chooseCell(row, col, cell);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  location.oninput = () => location.setCustomValidity("");

  function render() {
    const sheet = workbook.sheets[sheetIndex];
    if (!sheet) {
      viewport.replaceChildren(
        node("p", "viewer-message", "This workbook has no worksheets."),
      );
      return;
    }
    const lastRow = Math.min(sheet.rowCount, startRow + rowPage - 1),
      lastColumn = Math.min(sheet.columnCount, startColumn + colPage - 1);
    const rows = [],
      cols = [];
    for (let r = startRow; r <= lastRow; r++)
      if (showHidden || !sheet.rows[r]?.hidden) rows.push(r);
    for (let c = startColumn; c <= lastColumn; c++)
      if (showHidden || !sheet.columns[c]?.hidden) cols.push(c);
    const surface = node("div", "sheet-surface");
    surface.style.zoom = zoom;
    const table = node(
      "table",
      `sheet-grid${sheet.gridlines ? "" : " no-gridlines"}`,
    );
    table.setAttribute("aria-label", sheet.name);
    const widths = new Map(
      cols.map((c) => [c, sheet.columns[c]?.width || sheet.defaultColumnWidth]),
    );
    const heights = new Map(
      rows.map((r) => [r, sheet.rows[r]?.height || sheet.defaultRowHeight]),
    );
    const colgroup = document.createElement("colgroup"),
      cornerCol = document.createElement("col");
    cornerCol.style.width = "44px";
    colgroup.append(cornerCol);
    for (const col of cols) {
      const el = document.createElement("col");
      el.style.width = `${widths.get(col)}px`;
      colgroup.append(el);
    }
    table.style.width = `${44 + [...widths.values()].reduce((sum, width) => sum + width, 0)}px`;
    table.append(colgroup);
    const head = document.createElement("thead"),
      headings = document.createElement("tr");
    headings.append(node("th", "sheet-corner", ""));
    for (const col of cols) {
      const th = node("th", "", columnName(col));
      th.scope = "col";
      headings.append(th);
    }
    head.append(headings);
    table.append(head);
    const covered = new Set(),
      merged = new Map();
    for (const merge of sheet.merges) {
      const mergeRows = rows.filter(
          (r) => r >= merge.s.r + 1 && r <= merge.e.r + 1,
        ),
        mergeCols = cols.filter(
          (c) => c >= merge.s.c + 1 && c <= merge.e.c + 1,
        );
      if (!mergeRows.length || !mergeCols.length) continue;
      merged.set(`${mergeRows[0]}:${mergeCols[0]}`, {
        rowSpan: mergeRows.length,
        colSpan: mergeCols.length,
        master: `${merge.s.r + 1}:${merge.s.c + 1}`,
        height: mergeRows.reduce((sum, r) => sum + heights.get(r), 0),
      });
      for (const r of mergeRows)
        for (const c of mergeCols)
          if (r !== mergeRows[0] || c !== mergeCols[0])
            covered.add(`${r}:${c}`);
    }
    const body = document.createElement("tbody");
    for (const r of rows) {
      const row = document.createElement("tr");
      row.style.height = `${heights.get(r)}px`;
      const heading = node("th", "sheet-row-number", String(r));
      heading.scope = "row";
      row.append(heading);
      for (const c of cols) {
        const key = `${r}:${c}`;
        if (covered.has(key)) continue;
        const merge = merged.get(key),
          data = sheet.cells[merge?.master || key];
        const cell = node("td", "sheet-cell");
        cell.dataset.cell = `${columnName(c)}${r}`;
        if (merge) {
          cell.rowSpan = merge.rowSpan;
          cell.colSpan = merge.colSpan;
        }
        Object.assign(cell.style, workbook.styles[data?.style] || {});
        const content = node("div", "sheet-cell-content");
        content.style.maxHeight = `${Math.max(16, (merge?.height || heights.get(r)) - 1)}px`;
        if (data?.runs)
          for (const run of data.runs) {
            const span = node("span", "", run.text);
            Object.assign(span.style, run.css);
            content.append(span);
          }
        else content.textContent = data?.text || "";
        if (data?.rotation === "vertical")
          content.style.writingMode = "vertical-rl";
        else if (data?.rotation) {
          content.style.transform = `rotate(${-data.rotation}deg)`;
          content.style.transformOrigin = "center";
        }
        cell.title = data?.formula
          ? `=${data.formula}\n${data.text}`
          : data?.text || "";
        cell.onclick = () => chooseCell(r, c, cell);
        cell.append(content);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    surface.append(table);
    const xPositions = new Map(),
      yPositions = new Map();
    let x = 44,
      y = 24;
    for (const c of cols) {
      xPositions.set(c, x);
      x += widths.get(c);
    }
    for (const r of rows) {
      yPositions.set(r, y);
      y += heights.get(r);
    }
    for (const image of sheet.images || []) {
      const c = Math.floor(image.col) + 1,
        r = Math.floor(image.row) + 1;
      if (!xPositions.has(c) || !yPositions.has(r)) continue;
      const img = node("img", "sheet-image");
      img.src = image.src;
      img.alt = "Embedded worksheet image";
      const left = xPositions.get(c) + (image.col % 1) * widths.get(c),
        top = yPositions.get(r) + (image.row % 1) * heights.get(r);
      img.style.left = `${left}px`;
      img.style.top = `${top}px`;
      const endC = Math.floor(image.endCol) + 1,
        endR = Math.floor(image.endRow) + 1;
      img.style.width = `${image.width || Math.max(1, (xPositions.get(endC) ?? x) + (image.endCol % 1 || 0) * (widths.get(endC) || 0) - left)}px`;
      img.style.height = `${image.height || Math.max(1, (yPositions.get(endR) ?? y) + (image.endRow % 1 || 0) * (heights.get(endR) || 0) - top)}px`;
      surface.append(img);
    }
    viewport.replaceChildren(surface);
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    rowPrev.disabled = startRow === 1;
    rowNext.disabled = lastRow === sheet.rowCount;
    colPrev.disabled = startColumn === 1;
    colNext.disabled = lastColumn === sheet.columnCount;
    rangeLabel.textContent = `${columnName(startColumn)}${startRow}–${columnName(lastColumn)}${lastRow}`;
    tabs.replaceChildren();
    workbook.sheets.forEach((item, index) => {
      if (item.hidden && !showHidden) return;
      const tab = button(
        item.name + (item.hidden ? " (hidden)" : ""),
        item.name + (item.hidden ? " (hidden)" : ""),
        () => chooseSheet(index),
      );
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(sheetIndex === index));
      tabs.append(tab);
    });
  }
  render();
  return {
    destroy() {
      disposed = true;
      sheetRequest++;
      root.remove();
    },
    resize() {},
  };
}

export async function pdfViewer(container, file, isCurrent = () => true) {
  const pdfjs = await import("../node_modules/pdfjs-dist/build/pdf.mjs");
  if (!isCurrent()) return { destroy() {}, resize() {} };
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url,
  ).href;
  const root = node("div", "pdf-viewer"),
    toolbar = node("div", "viewer-toolbar");
  const stage = node("div", "pdf-stage"),
    status = node("span", "pdf-page-count", "Loading…");
  const pageInput = node("input", "pdf-page-input");
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.value = "1";
  pageInput.setAttribute("aria-label", "PDF page");
  let documentProxy,
    currentPage = 1,
    scale = "fit",
    rotation = 0,
    task,
    generation = 0,
    disposed = false,
    resizeTimer;
  const previous = button("Previous PDF page", "←", () => {
    if (currentPage > 1) {
      currentPage--;
      render();
    }
  });
  const next = button("Next PDF page", "→", () => {
    if (currentPage < documentProxy.numPages) {
      currentPage++;
      render();
    }
  });
  previous.disabled = next.disabled = pageInput.disabled = true;
  const zoom = select(
    "PDF zoom",
    [
      ["fit", "Fit width"],
      ["0.5", "50%"],
      ["0.75", "75%"],
      ["1", "100%"],
      ["1.5", "150%"],
      ["2", "200%"],
    ],
    "fit",
    (value) => {
      scale = value;
      render();
    },
  );
  const rotate = button("Rotate PDF page", "↻", () => {
    rotation = (rotation + 90) % 360;
    render();
  });
  toolbar.append(previous, pageInput, status, next, zoom, rotate);
  root.append(toolbar, stage);
  container.replaceChildren(root);
  const loading = pdfjs.getDocument({
    data: new Uint8Array(file.data),
    isEvalSupported: false,
    useWasm: false,
    useSystemFonts: true,
    cMapUrl: new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url).href,
    cMapPacked: true,
    wasmUrl: new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url).href,
    standardFontDataUrl: new URL(
      "../node_modules/pdfjs-dist/standard_fonts/",
      import.meta.url,
    ).href,
  });
  const destroy = () => {
    disposed = true;
    generation++;
    clearTimeout(resizeTimer);
    task?.cancel();
    loading.destroy().catch(() => {});
    root.remove();
  };
  const render = async () => {
    if (disposed || !documentProxy) return;
    const version = ++generation;
    task?.cancel();
    pageInput.value = String(currentPage);
    status.textContent = `/ ${documentProxy.numPages}`;
    previous.disabled = currentPage <= 1;
    next.disabled = currentPage >= documentProxy.numPages;
    try {
      const page = await documentProxy.getPage(currentPage);
      if (disposed || version !== generation) return;
      const base = page.getViewport({
        scale: 1,
        rotation: (page.rotate + rotation) % 360,
      });
      const ratio =
        scale === "fit"
          ? Math.max(0.2, (stage.clientWidth - 32) / base.width)
          : Number(scale);
      const viewport = page.getViewport({
        scale: Math.min(ratio, 4),
        rotation: base.rotation,
      });
      const density = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(12000000 / (viewport.width * viewport.height)),
      );
      const paper = node("div", "pdf-paper"),
        canvas = document.createElement("canvas");
      paper.style.width = `${viewport.width}px`;
      paper.style.height = `${viewport.height}px`;
      paper.style.setProperty("--scale-factor", String(viewport.scale));
      paper.style.setProperty("--total-scale-factor", String(viewport.scale));
      canvas.width = Math.ceil(viewport.width * density);
      canvas.height = Math.ceil(viewport.height * density);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("aria-label", `PDF page ${currentPage}`);
      paper.append(canvas);
      stage.replaceChildren(paper);
      task = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: [density, 0, 0, density, 0, 0],
        annotationMode: pdfjs.AnnotationMode.ENABLE,
      });
      await task.promise;
      if (disposed || version !== generation) return;
      const text = node("div", "textLayer");
      paper.append(text);
      const textContent = await page.getTextContent();
      if (disposed || version !== generation) return;
      await new pdfjs.TextLayer({
        textContentSource: textContent,
        container: text,
        viewport,
      }).render();
      root.dataset.renderedPage = String(currentPage);
    } catch (error) {
      if (
        disposed ||
        version !== generation ||
        error.name === "RenderingCancelledException"
      )
        return;
      stage.replaceChildren(
        node("p", "viewer-message", "This PDF page could not be rendered."),
      );
    }
  };
  pageInput.onchange = () => {
    currentPage = Math.max(
      1,
      Math.min(
        documentProxy?.numPages || 1,
        Math.trunc(Number(pageInput.value) || 1),
      ),
    );
    render();
  };
  const ready = loading.promise
    .then(async (proxy) => {
      documentProxy = proxy;
      if (disposed) return { destroy, resize() {} };
      pageInput.disabled = false;
      pageInput.max = String(documentProxy.numPages);
      await render();
    })
    .catch((error) => {
      stage.replaceChildren(
        node(
          "p",
          "viewer-message",
          error.name === "PasswordException"
            ? "This PDF is password-protected. Open an unlocked local copy to preview it."
            : "This PDF could not be opened. The file may be damaged.",
        ),
      );
      status.textContent = "";
      previous.disabled = next.disabled = pageInput.disabled = true;
    });
  return {
    destroy,
    ready,
    resize() {
      if (scale === "fit") {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(render, 100);
      }
    },
  };
}
