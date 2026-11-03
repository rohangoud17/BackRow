import {
  classifyUpload,
  chunkIndexName,
  createSessionRequestSchema,
  documentObjectKey,
  generateId,
  isValidId,
  parseDocumentObjectKey,
  courseKey,
  documentKey,
  creatorQuotaKey,
  ID_LENGTH,
  MAX_UPLOAD_BYTES,
} from "./course";

const seq = (start = 0) => (n: number) =>
  Uint8Array.from({ length: n }, (_, i) => (start + i * 37) % 256);

describe("ids", () => {
  test("generated ids are valid and the right length", () => {
    for (let s = 0; s < 50; s++) {
      const id = generateId(seq(s));
      expect(id).toHaveLength(ID_LENGTH);
      expect(isValidId(id)).toBe(true);
    }
  });

  test("ids are valid S3 Vectors index-name fragments", () => {
    // 3-63 chars, lowercase letters, digits, hyphens, dots.
    const name = chunkIndexName("default", generateId(seq(7)));
    expect(name).toMatch(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  });

  test("rejects malformed ids", () => {
    for (const bad of ["", "ABCDEFGHJKMN", "abc", "abcdefghjkm0", "abcdefghjkm/", "a".repeat(13)]) {
      expect(isValidId(bad)).toBe(false);
    }
  });
});

describe("keys", () => {
  test("course-scoped keys carry the org above the course", () => {
    expect(courseKey("default", "c1")).toEqual({ PK: "ORG#default#COURSE#c1", SK: "META" });
    expect(documentKey("default", "c1", "d1")).toEqual({
      PK: "ORG#default#COURSE#c1",
      SK: "DOC#d1",
    });
  });

  test("the quota key holds only a hash prefix, never a full key", () => {
    const hash = "f".repeat(64);
    const key = creatorQuotaKey("default", hash);
    expect(key.PK).toBe(`ORG#default#CREATOR#${"f".repeat(16)}`);
    expect(key.PK).not.toContain(hash);
  });
});

describe("object keys", () => {
  const courseId = generateId(seq(1));
  const docId = generateId(seq(2));

  test("round-trip", () => {
    const key = documentObjectKey("default", courseId, docId, "pdf");
    expect(key).toBe(`raw/default/${courseId}/${docId}.pdf`);
    expect(parseDocumentObjectKey(key)).toEqual({ orgId: "default", courseId, docId, ext: "pdf" });
  });

  test("ignores anything outside the layout", () => {
    for (const key of [
      `processed/default/${courseId}/${docId}.pdf`,
      `raw/default/${courseId}/${docId}.pptx`,
      `raw/default/${courseId}/${docId}`,
      `raw/default/../${docId}.pdf`,
      `raw/default/${courseId}/nested/${docId}.pdf`,
      `raw/default/short/${docId}.pdf`,
    ]) {
      expect(parseDocumentObjectKey(key)).toBeUndefined();
    }
  });
});

describe("classifyUpload", () => {
  test("accepts pdf, txt and md, case-insensitively", () => {
    expect(classifyUpload("Lecture 4.PDF")).toMatchObject({
      ok: true,
      ext: "pdf",
      contentType: "application/pdf",
      maxBytes: MAX_UPLOAD_BYTES,
    });
    expect(classifyUpload("notes.txt")).toMatchObject({ ok: true, ext: "txt" });
    expect(classifyUpload("syllabus.md")).toMatchObject({ ok: true, contentType: "text/markdown" });
  });

  test("slides and documents are told to export to PDF", () => {
    for (const name of ["deck.pptx", "deck.ppt", "talk.key", "paper.docx", "paper.doc", "notes.odt"]) {
      const r = classifyUpload(name);
      expect(r).toMatchObject({ ok: false, code: "EXPORT_TO_PDF" });
      if (!r.ok) expect(r.message).toMatch(/Export to PDF and re-upload/);
    }
  });

  test("anything else is a generic unsupported type", () => {
    for (const name of ["photo.jpg", "archive.zip", "README", "script.pdf.exe"]) {
      expect(classifyUpload(name)).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
    }
  });
});

describe("createSessionRequestSchema", () => {
  const courseId = generateId(seq(3));

  test("an empty body is a session with no course", () => {
    expect(createSessionRequestSchema.safeParse({}).success).toBe(true);
  });

  test("courseId and token together", () => {
    expect(createSessionRequestSchema.safeParse({ courseId, courseToken: "t" }).success).toBe(true);
  });

  test("a token without a course id is rejected", () => {
    expect(createSessionRequestSchema.safeParse({ courseToken: "t" }).success).toBe(false);
  });

  test("a malformed course id is rejected", () => {
    expect(createSessionRequestSchema.safeParse({ courseId: "NOPE" }).success).toBe(false);
  });
});
