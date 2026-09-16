import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(buffer, filePath) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${filePath} is not a PNG file.`);

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let palette;
  let paletteAlpha;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset); offset += 4;
    const type = buffer.toString("ascii", offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length); offset += length + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") paletteAlpha = data;
    else if (type === "IDAT") idat.push(data);
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![0, 2, 3, 6].includes(colorType)) {
    throw new Error(`${filePath} must be a non-interlaced 8-bit grayscale, RGB, indexed-color, or RGBA PNG.`);
  }
  if (colorType === 3 && !palette) throw new Error(`${filePath} is an indexed PNG without a palette.`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const compressed = inflateSync(Buffer.concat(idat));
  if (compressed.length !== height * (stride + 1)) throw new Error(`${filePath} has unexpected PNG scanline data.`);

  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = compressed[sourceOffset++];
    const current = Buffer.from(compressed.subarray(sourceOffset, sourceOffset + stride));
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      if (filter === 1) current[index] = (current[index] + left) & 255;
      else if (filter === 2) current[index] = (current[index] + above) & 255;
      else if (filter === 3) current[index] = (current[index] + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) current[index] = (current[index] + paeth(left, above, upperLeft)) & 255;
      else if (filter !== 0) throw new Error(`${filePath} uses an unsupported PNG filter.`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const destination = (row * width + x) * 4;
      if (colorType === 0) pixels.fill(current[source], destination, destination + 3);
      else if (colorType === 3) {
        const paletteIndex = current[source] * 3;
        pixels[destination] = palette[paletteIndex];
        pixels[destination + 1] = palette[paletteIndex + 1];
        pixels[destination + 2] = palette[paletteIndex + 2];
        pixels[destination + 3] = paletteAlpha?.[current[source]] ?? 255;
      }
      else {
        pixels[destination] = current[source];
        pixels[destination + 1] = current[source + 1];
        pixels[destination + 2] = current[source + 2];
      }
      pixels[destination + 3] = colorType === 6 ? current[source + 3] : 255;
    }
    previous = current;
  }
  return { width, height, pixels };
}

export async function comparePngFiles(referencePath, actualPath, perChannelThreshold = 16) {
  const [referenceBuffer, actualBuffer] = await Promise.all([readFile(referencePath), readFile(actualPath)]);
  const reference = decodePng(referenceBuffer, referencePath);
  const actual = decodePng(actualBuffer, actualPath);
  const result = {
    reference: { path: referencePath, width: reference.width, height: reference.height },
    unity: { path: actualPath, width: actual.width, height: actual.height },
    threshold: perChannelThreshold
  };
  if (reference.width !== actual.width || reference.height !== actual.height) {
    return { ...result, comparable: false, message: "Image dimensions differ. Capture Unity at the Penpot frame resolution before comparing pixels." };
  }

  let totalAbsoluteDifference = 0;
  let changedPixels = 0;
  let maxDifference = 0;
  let minX = reference.width;
  let minY = reference.height;
  let maxX = -1;
  let maxY = -1;
  const pixels = reference.width * reference.height;
  for (let index = 0; index < reference.pixels.length; index += 4) {
    let pixelDifference = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(reference.pixels[index + channel] - actual.pixels[index + channel]);
      totalAbsoluteDifference += difference;
      pixelDifference = Math.max(pixelDifference, difference);
      maxDifference = Math.max(maxDifference, difference);
    }
    if (pixelDifference > perChannelThreshold) {
      changedPixels += 1;
      const pixel = index / 4;
      const x = pixel % reference.width;
      const y = Math.floor(pixel / reference.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return {
    ...result,
    comparable: true,
    meanAbsoluteChannelDifference: Number((totalAbsoluteDifference / (pixels * 4)).toFixed(3)),
    changedPixelCount: changedPixels,
    changedPixelPercent: Number(((changedPixels / pixels) * 100).toFixed(3)),
    maxChannelDifference: maxDifference,
    changedBounds: changedPixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  };
}
