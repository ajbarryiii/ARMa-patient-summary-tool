"use strict";
const yauzl = require("yauzl");

function validateZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error)
        return reject(
          new Error("This Excel workbook is damaged or encrypted."),
        );
      let size = 0,
        entries = 0;
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        size += entry.uncompressedSize;
        if (
          ++entries > 20000 ||
          size > 128 * 1024 * 1024 ||
          entry.generalPurposeBitFlag & 1
        ) {
          zip.close();
          reject(
            new Error("This workbook is encrypted or too large to preview."),
          );
          return;
        }
        zip.readEntry();
      });
      zip.once("end", () => resolve());
      zip.readEntry();
    });
  });
}
module.exports = { validateZip };
