// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const streamToArray = require("stream-to-array");
const crypto = require("crypto");

import { Readable } from "stream";

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function convertObjectToSnakeCase(obj: any): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item: any) => convertObjectToSnakeCase(item));
  }

  return Object.keys(obj).reduce((acc, key) => {
    const snakeCaseKey: string = toSnakeCase(key);
    acc[snakeCaseKey] = convertObjectToSnakeCase(obj[key]);
    return acc;
  }, {} as any);
}

export async function streamToBuffer(readableStream: Readable): Promise<ArrayBuffer> {
  const buffers = [];
  for await (const data of readableStream) {
    buffers.push(data);
  }
  const finalBuffer = Buffer.concat(buffers);
  return finalBuffer;
}

export function hashWithSHA256(input: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(input);
  return hash.digest("hex");
}
