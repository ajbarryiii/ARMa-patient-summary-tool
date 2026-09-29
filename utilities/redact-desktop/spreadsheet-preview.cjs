"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const SSF = require("ssf");
const { validateZip } = require("./workbook-archive.cjs");

const MAX_CELLS = 300000;
const MAX_SHEETS = 64;
const DEFAULT_THEME = [
  "FFFFFF",
  "000000",
  "EEECE1",
  "1F497D",
  "4F81BD",
  "C0504D",
  "9BBB59",
  "8064A2",
  "4BACC6",
  "F79646",
  "0000FF",
  "800080",
];
const INDEXED = [
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "800000",
  "008000",
  "000080",
  "808000",
  "800080",
  "008080",
  "C0C0C0",
  "808080",
  "9999FF",
  "993366",
  "FFFFCC",
  "CCFFFF",
  "660066",
  "FF8080",
  "0066CC",
  "CCCCFF",
  "000080",
  "FF00FF",
  "FFFF00",
  "00FFFF",
  "800080",
  "800000",
  "008080",
  "0000FF",
  "00CCFF",
  "CCFFFF",
  "CCFFCC",
  "FFFF99",
  "99CCFF",
  "FF99CC",
  "CC99FF",
  "FFCC99",
  "3366FF",
  "33CCCC",
  "99CC00",
  "FFCC00",
  "FF9900",
  "FF6600",
  "666699",
  "969696",
  "003366",
  "339966",
  "003300",
  "333300",
  "993300",
  "993366",
  "333399",
  "333333",
];
const clamp = (value, min, max, fallback) =>
  Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Number(value)))
    : fallback;

function themeColors(workbook) {
  const xml =
    Object.values(workbook.model.themes || {}).find(
      (value) => typeof value === "string",
    ) || "";
  const scheme =
    xml.match(
      /<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme>/,
    )?.[1] || "";
  const byName = {};
  for (const match of scheme.matchAll(
    /<(?:\w+:)?(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/(?:\w+:)?\1>/g,
  )) {
    const color = match[2].match(/\b(?:lastClr|val)="([A-Fa-f\d]{6})"/);
    if (color) byName[match[1]] = color[1];
  }
  return [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ].map((name, i) => byName[name] || DEFAULT_THEME[i]);
}

function color(value, theme, fallback) {
  if (!value) return fallback;
  let hex =
    value.argb || value.rgb || theme[value.theme] || INDEXED[value.indexed];
  if (typeof hex !== "string" || !/^(?:[a-f\d]{8}|[a-f\d]{6})$/i.test(hex))
    return fallback;
  hex = hex.slice(-6);
  const tint = clamp(value.tint ?? 0, -1, 1, 0);
  return (
    "#" +
    [0, 2, 4]
      .map((start) => {
        const component = parseInt(hex.slice(start, start + 2), 16);
        return Math.round(
          tint < 0
            ? component * (1 + tint)
            : component + (255 - component) * tint,
        )
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

function fontStyle(font = {}, theme = DEFAULT_THEME) {
  const css = {};
  if (font.name)
    css.fontFamily = `"${String(font.name)
      .replace(/["\\\r\n]/g, "")
      .slice(0, 120)}", Calibri, Arial, sans-serif`;
  if (font.size) css.fontSize = `${clamp(font.size, 1, 100, 11)}pt`;
  if (font.bold) css.fontWeight = "700";
  if (font.italic) css.fontStyle = "italic";
  if (font.underline || font.strike)
    css.textDecoration = [
      font.underline ? "underline" : "",
      font.strike ? "line-through" : "",
    ]
      .filter(Boolean)
      .join(" ");
  if (font.vertAlign === "superscript" || font.vertAlign === "subscript") {
    css.verticalAlign = font.vertAlign === "superscript" ? "super" : "sub";
    css.fontSize = "75%";
  }
  const foreground = color(font.color, theme);
  if (foreground) css.color = foreground;
  return css;
}

function styleCSS(style = {}, theme = DEFAULT_THEME, numeric = false) {
  const css = { ...fontStyle(style.font, theme) };
  const a = style.alignment || {};
  css.textAlign =
    {
      left: "left",
      right: "right",
      center: "center",
      centerContinuous: "center",
      justify: "justify",
      distributed: "justify",
    }[a.horizontal] || (numeric ? "right" : "left");
  css.verticalAlign =
    {
      top: "top",
      middle: "middle",
      bottom: "bottom",
      justify: "middle",
      distributed: "middle",
    }[a.vertical] || "bottom";
  css.whiteSpace = a.wrapText ? "pre-wrap" : "pre";
  if (a.indent) css.paddingLeft = `${clamp(a.indent, 0, 50, 0) * 10 + 4}px`;
  const fill = style.fill;
  if (fill?.type === "pattern" && fill.pattern !== "none") {
    const fg = color(fill.fgColor, theme, "#ffffff"),
      bg = color(fill.bgColor, theme, "#ffffff");
    css.backgroundColor = fg;
    if (fill.pattern && fill.pattern !== "solid")
      css.backgroundImage = `repeating-linear-gradient(45deg, ${fg} 0 1px, ${bg} 1px 3px)`;
  } else if (fill?.type === "gradient" && fill.stops?.length) {
    css.backgroundImage = `linear-gradient(${clamp(fill.degree, 0, 360, 0)}deg, ${fill.stops
      .slice(0, 16)
      .map(
        (stop) =>
          `${color(stop.color, theme, "#ffffff")} ${clamp(stop.position, 0, 1, 0) * 100}%`,
      )
      .join(", ")})`;
  }
  const borders = {
    hair: "0.5px solid",
    thin: "1px solid",
    medium: "2px solid",
    thick: "3px solid",
    double: "3px double",
    dotted: "1px dotted",
    dashed: "1px dashed",
    dashDot: "1px dashed",
    dashDotDot: "1px dashed",
    mediumDashed: "2px dashed",
    mediumDashDot: "2px dashed",
    mediumDashDotDot: "2px dashed",
    slantDashDot: "1px dashed",
  };
  for (const side of ["top", "bottom", "left", "right"]) {
    const edge = style.border?.[side];
    if (borders[edge?.style])
      css[`border${side[0].toUpperCase()}${side.slice(1)}`] =
        `${borders[edge.style]} ${color(edge.color, theme, "#000000")}`;
  }
  return css;
}

function bounds(merges, rows, columns) {
  for (const range of merges) {
    rows = Math.max(rows, range.e.r + 1);
    columns = Math.max(columns, range.e.c + 1);
  }
  if (rows > 1048576 || columns > 16384)
    throw new Error("This workbook has invalid sheet dimensions.");
  return { rowCount: Math.max(rows, 1), columnCount: Math.max(columns, 1) };
}

function formatted(value, format, date1904) {
  if (value == null) return "";
  if (typeof value === "object" && value.error) return String(value.error);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date)
    value = value.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0);
  if (typeof value === "number") {
    try {
      return SSF.format(format || "General", value, { date1904 });
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function parseWorkbook(data, extension, sheetIndex) {
  const bytes = Buffer.from(data);
  let cellCount = 0;
  const warnings = new Set();
  const styles = [],
    styleMap = new Map();
  const intern = (css) => {
    const key = JSON.stringify(css);
    if (!styleMap.has(key)) {
      styleMap.set(key, styles.length);
      styles.push(css);
    }
    return styleMap.get(key);
  };
  const count = () => {
    if (++cellCount > MAX_CELLS)
      throw new Error(
        "Workbook previews are limited to 300,000 populated or styled cells.",
      );
  };
  let sheets, selection;
  if (extension === ".xlsx" || extension === ".xlsm") {
    await validateZip(bytes);
    if (sheetIndex !== undefined)
      selection = await require("./xlsx-preview-sheet.cjs").previewSheet(
        bytes,
        sheetIndex,
      );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(selection ? selection.bytes : bytes);
    if (workbook.worksheets.length > MAX_SHEETS)
      throw new Error("Workbook previews are limited to 64 sheets.");
    const theme = themeColors(workbook),
      date1904 = !!workbook.properties.date1904;
    sheets = workbook.worksheets.map((sheet) => {
      const cells = {},
        rows = {},
        columns = {};
      const merges = (sheet.model.merges || []).map(XLSX.utils.decode_range);
      (sheet.model.rows || []).forEach((rowModel) => {
        const row = sheet.getRow(rowModel.number);
        rows[row.number] = {
          height: clamp(
            ((row.height ?? sheet.properties.defaultRowHeight ?? 15) * 4) / 3,
            2,
            1000,
            20,
          ),
          hidden: !!row.hidden,
        };
        rowModel.cells.forEach((cellModel) => {
          const cell = sheet.getCell(cellModel.address);
          // XLSX is loaded one worksheet at a time by the GUI; memory/time
          // limits bound parsing without counting styled blank cells globally.
          if (cell.isMerged && cell.master.address !== cell.address) return;
          const original = cell.value;
          let value = original;
          let formula;
          if (
            original &&
            typeof original === "object" &&
            !(original instanceof Date)
          ) {
            if ("formula" in original || "sharedFormula" in original) {
              formula = cell.formula || original.formula;
              // ExcelJS's value getter omits falsy cached results. The result
              // getter retains saved zero, false, and empty-string values.
              value = cell.result;
              if (value === undefined)
                warnings.add(
                  "Some formulas have no saved result; their formula text is shown.",
                );
            } else if (original.richText)
              value = original.richText.map((run) => run.text).join("");
            else value = original.text ?? original.error ?? "";
          }
          const css = styleCSS(
            cell.style,
            theme,
            typeof value === "number" || value instanceof Date,
          );
          const text =
            value === undefined && formula
              ? `=${formula}`
              : formatted(value, cell.numFmt, date1904);
          const record = { text, style: intern(css) };
          if (formula) record.formula = String(formula).slice(0, 10000);
          if (original?.richText)
            record.runs = original.richText.map((run) => ({
              text: String(run.text),
              css: fontStyle(run.font, theme),
            }));
          const rotation = cell.alignment?.textRotation;
          if (rotation)
            record.rotation =
              rotation === "vertical"
                ? "vertical"
                : clamp(rotation, -90, 90, 0);
          cells[`${cell.row}:${cell.col}`] = record;
        });
      });
      (sheet.columns || []).forEach((column, index) => {
        columns[index + 1] = {
          width: clamp(
            (column.width ?? sheet.properties.defaultColWidth ?? 9) * 7 + 5,
            2,
            1800,
            68,
          ),
          hidden: !!column.hidden,
        };
      });
      // Preserve blank but explicitly sized/hidden rows too.
      for (const row of sheet.model.rows || [])
        if (row.height || row.hidden)
          rows[row.number] = {
            height: clamp(((row.height ?? 15) * 4) / 3, 2, 1000, 20),
            hidden: !!row.hidden,
          };
      const images = [];
      for (const drawing of sheet.getImages()) {
        const media = workbook.getImage(drawing.imageId),
          range = drawing.range;
        if (
          !media ||
          !["png", "jpeg", "gif"].includes(media.extension) ||
          !range.tl
        )
          continue;
        const imageBytes = media.buffer
          ? Buffer.from(media.buffer)
          : media.base64
            ? Buffer.from(media.base64.split(",").pop(), "base64")
            : null;
        if (!imageBytes || imageBytes.length > 4 * 1024 * 1024) {
          warnings.add("An embedded image was too large to preview.");
          continue;
        }
        images.push({
          src: `data:image/${media.extension};base64,${imageBytes.toString("base64")}`,
          col: range.tl.col,
          row: range.tl.row,
          endCol: range.br?.col,
          endRow: range.br?.row,
          width: range.ext?.width,
          height: range.ext?.height,
        });
      }
      if (sheet.conditionalFormattings?.length)
        warnings.add(
          "Conditional formatting rules are not evaluated in this preview.",
        );
      if (sheet.model.drawing?.anchors?.some((anchor) => anchor.graphicFrame))
        warnings.add("Charts and drawing objects may not appear.");
      return {
        name: sheet.name,
        hidden: sheet.state !== "visible",
        ...bounds(merges, sheet.rowCount, sheet.columnCount),
        cells,
        rows,
        columns,
        merges,
        images,
        gridlines: sheet.views?.[0]?.showGridLines !== false,
        defaultRowHeight: clamp(
          ((sheet.properties.defaultRowHeight || 15) * 4) / 3,
          2,
          1000,
          20,
        ),
        defaultColumnWidth: clamp(
          (sheet.properties.defaultColWidth || 9) * 7 + 5,
          2,
          1800,
          68,
        ),
      };
    });
  } else {
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      cellStyles: true,
      cellNF: true,
      cellText: true,
      cellHTML: false,
      bookVBA: false,
      raw: extension !== ".xls",
      ...(extension === ".tsv" ? { FS: "\t" } : {}),
    });
    if (workbook.SheetNames.length > MAX_SHEETS)
      throw new Error("Workbook previews are limited to 64 sheets.");
    if (extension === ".xls")
      warnings.add(
        "Legacy XLS previews preserve values, number formats, merges and dimensions; some visual styles may differ. Save as XLSX for fuller styling.",
      );
    sheets = workbook.SheetNames.map((name, index) => {
      const sheet = workbook.Sheets[name],
        cells = {},
        rows = {},
        columns = {};
      const range = XLSX.utils.decode_range(sheet["!ref"] || "A1"),
        merges = sheet["!merges"] || [];
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith("!")) continue;
        count();
        const { r, c } = XLSX.utils.decode_cell(address);
        const css = styleCSS(
          cell.s ? { fill: { type: "pattern", ...cell.s } } : {},
          DEFAULT_THEME,
          cell.t === "n",
        );
        cells[`${r + 1}:${c + 1}`] = {
          text: cell.w ?? String(cell.v ?? (cell.f ? `=${cell.f}` : "")),
          style: intern(css),
          ...(cell.f ? { formula: cell.f } : {}),
        };
      }
      (sheet["!rows"] || []).forEach((row, i) => {
        if (row)
          rows[i + 1] = {
            height: clamp(row.hpx ?? (row.hpt * 4) / 3, 2, 1000, 20),
            hidden: !!row.hidden,
          };
      });
      (sheet["!cols"] || []).forEach((col, i) => {
        if (col)
          columns[i + 1] = {
            width: clamp(col.wpx ?? col.wch * 7 + 5, 2, 1800, 68),
            hidden: !!col.hidden,
          };
      });
      return {
        name,
        hidden: !!workbook.Workbook?.Sheets?.[index]?.Hidden,
        ...bounds(merges, range.e.r + 1, range.e.c + 1),
        cells,
        rows,
        columns,
        merges,
        images: [],
        gridlines: true,
        defaultRowHeight: 20,
        defaultColumnWidth: 90,
      };
    });
  }
  if (selection) {
    const loaded = sheets[0];
    if (!loaded || loaded.name !== selection.sheets[selection.activeSheet].name)
      throw new Error("Invalid worksheet preview.");
    sheets = selection.sheets.map((sheet, index) =>
      index === selection.activeSheet ? loaded : sheet,
    );
  }
  return {
    sheets,
    styles,
    warnings: [...warnings],
    ...(selection
      ? { activeSheet: selection.activeSheet, lazySheets: true }
      : {}),
  };
}

if (parentPort && require.main === module)
  parseWorkbook(workerData.bytes, workerData.extension, workerData.sheetIndex)
    .then((workbook) => parentPort.postMessage({ workbook }))
    .catch((error) =>
      parentPort.postMessage({
        error: /limit|too large|invalid sheet|encrypted|damaged/.test(
          error.message,
        )
          ? error.message
          : "This workbook could not be opened. It may be damaged or password-protected.",
      }),
    );
module.exports = { parseWorkbook, styleCSS, color, validateZip };
