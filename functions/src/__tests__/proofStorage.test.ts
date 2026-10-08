const exists = jest.fn();
const getMetadata = jest.fn();
const setMetadata = jest.fn();
const del = jest.fn();
const file = jest.fn(() => ({ exists, getMetadata, setMetadata, delete: del }));
const bucket = jest.fn(() => ({ file }));
jest.mock("firebase-admin/storage", () => ({ getStorage: () => ({ bucket }) }));

import {
  inspectProofObject,
  addSharedProofCities,
  releaseSharedProof,
  deleteProofObject,
  PROOFS_BUCKET_DEFAULT,
} from "../proofStorage";

beforeEach(() => jest.clearAllMocks());

describe("inspectProofObject", () => {
  it("returns null when the object is missing", async () => {
    getMetadata.mockRejectedValue({ code: 404 });
    await expect(inspectProofObject("proofs/g/u/abcdefgh.jpg", "bkt")).resolves.toBeNull();
    expect(bucket).toHaveBeenCalledWith("bkt");
    expect(file).toHaveBeenCalledWith("proofs/g/u/abcdefgh.jpg");
  });
  it("size and URL from ONE metadata read when the upload has a token", async () => {
    getMetadata.mockResolvedValue([{ size: "12345", metadata: { firebaseStorageDownloadTokens: "tok" } }]);
    const info = await inspectProofObject("proofs/g/u/abcdefgh.jpg", "bkt");
    expect(info).toEqual({
      size: 12345,
      url: "https://firebasestorage.googleapis.com/v0/b/bkt/o/proofs%2Fg%2Fu%2Fabcdefgh.jpg?alt=media&token=tok",
    });
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(exists).not.toHaveBeenCalled();
    expect(setMetadata).not.toHaveBeenCalled();
  });
  it("mints a token when the upload has none", async () => {
    getMetadata.mockResolvedValue([{ size: "1", metadata: {} }]);
    const info = await inspectProofObject("k", "bkt");
    const token = setMetadata.mock.calls[0][0].metadata.firebaseStorageDownloadTokens;
    expect(token).toBeTruthy();
    expect(info?.url).toContain(`token=${token}`);
  });
  it("rethrows anything but not-found", async () => {
    getMetadata.mockRejectedValue({ code: 500 });
    await expect(inspectProofObject("k", "bkt")).rejects.toEqual({ code: 500 });
  });
});

describe("shared photo references", () => {
  it("adds cities without duplicates, and skips the write when nothing is new", async () => {
    getMetadata.mockResolvedValue([{ metadata: { cities: "a,b" } }]);
    await addSharedProofCities("k", ["b", "c"], "bkt");
    expect(setMetadata).toHaveBeenCalledWith({ metadata: { cities: "a,b,c" } });
    setMetadata.mockClear();
    await addSharedProofCities("k", ["a"], "bkt");
    expect(setMetadata).not.toHaveBeenCalled();
  });
  it("a release keeps the photo while another city still shows it", async () => {
    getMetadata.mockResolvedValue([{ metadata: { cities: "a,b" } }]);
    await releaseSharedProof("k", "a", "bkt");
    expect(setMetadata).toHaveBeenCalledWith({ metadata: { cities: "b" } });
    expect(del).not.toHaveBeenCalled();
  });
  it("the last release deletes it", async () => {
    getMetadata.mockResolvedValue([{ metadata: { cities: "a" } }]);
    await releaseSharedProof("k", "a", "bkt");
    expect(del).toHaveBeenCalled();
  });
  it("releasing a photo that's already gone is fine", async () => {
    getMetadata.mockRejectedValue({ code: 404 });
    await expect(releaseSharedProof("k", "a", "bkt")).resolves.toBeUndefined();
  });
});

it("deleteProofObject deletes and ignores a missing object", async () => {
  del.mockRejectedValue({ code: 404 });
  await expect(deleteProofObject("k", "bkt")).resolves.toBeUndefined();
});

it("defaults to the app's configured bucket", () => {
  expect(PROOFS_BUCKET_DEFAULT).toBe("bitty-city.firebasestorage.app");
});
