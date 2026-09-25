// The text recognition's language data, shared by ocr.ts and vite.config.js,
// which serves and writes the files at /<OCR_DATA_DIR>/<lang>.traineddata.gz.

/** The languages the recognition runs with. */
export const OCR_LANGUAGES = ["deu", "eng"];

/** The top-level directory of the language data on the app's origin. */
export const OCR_DATA_DIR = "ocr";
