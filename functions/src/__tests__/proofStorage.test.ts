const exists = jest.fn();
const getMetadata = jest.fn();
const del = jest.fn();
const file = jest.fn(() => ({ exists, getMetadata, delete: del }));
const bucket = jest.fn(() => ({ file }));
jest.mock("firebase-admin/storage", () => ({ getStorage: () => ({ bucket }) }));

import { proofObjectSize, deleteProofObject, PROOFS_BUCKET_DEFAULT } from "../proofStorage";

beforeEach(() => jest.clearAllMocks());

describe("proofObjectSize", () => {
  it("returns null when the object is missing", async () => {
    exists.mockResolvedValue([false]);
    await expect(proofObjectSize("proofs/g/u/abcdefgh.jpg", "bkt")).resolves.toBeNull();
    expect(bucket).toHaveBeenCalledWith("bkt");
    expect(file).toHaveBeenCalledWith("proofs/g/u/abcdefgh.jpg");
  });
  it("returns the size when present (metadata size is a string)", async () => {
    exists.mockResolvedValue([true]);
    getMetadata.mockResolvedValue([{ size: "12345" }]);
    await expect(proofObjectSize("proofs/g/u/abcdefgh.jpg", "bkt")).resolves.toBe(12345);
  });
});

it("deleteProofObject deletes and ignores a missing object", async () => {
  del.mockRejectedValue({ code: 404 });
  await expect(deleteProofObject("k", "bkt")).resolves.toBeUndefined();
});

it("defaults to the app's configured bucket", () => {
  expect(PROOFS_BUCKET_DEFAULT).toBe("bitty-city.firebasestorage.app");
});
