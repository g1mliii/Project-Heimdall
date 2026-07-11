/** Test-only byte encoders for parser inputs that exercise BOM handling. */
export function encodeUtf16WithBom(input: string, endian: "le" | "be"): Uint8Array {
  const bytes = new Uint8Array(2 + input.length * 2);
  bytes[0] = endian === "le" ? 0xff : 0xfe;
  bytes[1] = endian === "le" ? 0xfe : 0xff;
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    bytes[2 + index * 2] = endian === "le" ? codeUnit & 0xff : codeUnit >> 8;
    bytes[3 + index * 2] = endian === "le" ? codeUnit >> 8 : codeUnit & 0xff;
  }
  return bytes;
}
