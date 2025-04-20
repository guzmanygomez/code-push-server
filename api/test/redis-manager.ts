// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as shortid from "shortid";
import { RedisManager, CacheableResponse } from "../script/redis-manager";

const redisManager: RedisManager = new RedisManager();

if (!redisManager.isEnabled) {
  console.log("Redis is not configured... Skipping redis tests");
} else {
  describe("Redis Cache", redisTests);
}

function redisTests() {
  const expectedResponse: CacheableResponse = {
    statusCode: 200,
    body: "",
  };

  after(() => {
    return redisManager.close();
  });

  it("should be healthy by default", () => {
    return redisManager.checkHealth();
  });

  it("first cache request should return null", () => {
    const expiryKey: string = "test:" + shortid.generate();
    const url: string = shortid.generate();
    return redisManager.getCachedResponse(expiryKey, url).then((cacheResponse: CacheableResponse) => {
      assert.strictEqual(cacheResponse, null);
    });
  });

  it("Should get cache request after setting it once", () => {
    const expiryKey: string = "test:" + shortid.generate();
    const url: string = shortid.generate();
    expectedResponse.statusCode = 200;
    expectedResponse.body = "I am cached";

    return redisManager
      .getCachedResponse(expiryKey, url)
      .then((cacheResponse: CacheableResponse) => {
        assert.strictEqual(cacheResponse, null);
        return redisManager.setCachedResponse(expiryKey, url, expectedResponse);
      })
      .then(() => {
        return redisManager.getCachedResponse(expiryKey, url);
      })
      .then((cacheResponse: CacheableResponse) => {
        assert.equal(cacheResponse.statusCode, expectedResponse.statusCode);
        assert.equal(cacheResponse.body, expectedResponse.body);
        return redisManager.getCachedResponse(expiryKey, url);
      })
      .then((cacheResponse: CacheableResponse) => {
        assert.equal(cacheResponse.statusCode, expectedResponse.statusCode);
        assert.equal(cacheResponse.body, expectedResponse.body);
        const newUrl: string = shortid.generate();
        return redisManager.getCachedResponse(expiryKey, newUrl);
      })
      .then((cacheResponse: CacheableResponse) => {
        assert.strictEqual(cacheResponse, null);
      });
  });

  it("should be able to invalidate cached request", () => {
    const expiryKey: string = "test:" + shortid.generate();
    const url: string = shortid.generate();
    expectedResponse.statusCode = 200;
    expectedResponse.body = "I am cached";

    return redisManager
      .getCachedResponse(expiryKey, url)
      .then((cacheResponse: CacheableResponse) => {
        assert.strictEqual(cacheResponse, null);
        return redisManager.setCachedResponse(expiryKey, url, expectedResponse);
      })
      .then(() => {
        return redisManager.getCachedResponse(expiryKey, url);
      })
      .then((cacheResponse: CacheableResponse) => {
        assert.equal(cacheResponse.statusCode, expectedResponse.statusCode);
        assert.equal(cacheResponse.body, expectedResponse.body);
        expectedResponse.body = "I am a new body";
        return redisManager.invalidateCache(expiryKey);
      })
      .then(() => {
        return redisManager.getCachedResponse(expiryKey, url);
      })
      .then((cacheResponse: CacheableResponse) => {
        assert.strictEqual(cacheResponse, null);
      });
  });
}
