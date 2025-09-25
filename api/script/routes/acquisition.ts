// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import * as semver from "semver";

import * as utils from "../utils/common";
import * as acquisitionUtils from "../utils/acquisition";
import * as errorUtils from "../utils/rest-error-handling";
import * as redis from "../redis-manager";
import * as restHeaders from "../utils/rest-headers";
import * as rolloutSelector from "../utils/rollout-selector";
import * as storageTypes from "../storage/storage";
import { UpdateCheckCacheResponse, UpdateCheckRequest, UpdateCheckResponse } from "../types/rest-definitions";
import * as validationUtils from "../utils/validation";

import * as q from "q";
import * as queryString from "querystring";
import * as URL from "url";

const METRICS_BREAKING_VERSION = "1.5.2-beta";

export interface AcquisitionConfig {
  storage: storageTypes.Storage;
  redisManager: redis.RedisManager;
}

function sanitizeClientQuery(query: Record<string, unknown>): any {
  if (!query) {
    return {};
  }

  const sanitizedQuery: any = { ...query };
  delete sanitizedQuery.clientUniqueId;
  delete sanitizedQuery.client_unique_id;

  return sanitizedQuery;
}

function getUrlKey(originalUrl: string): string {
  const parsedUrl: any = URL.parse(originalUrl, /*parseQueryString*/ true);
  const sanitizedQuery = sanitizeClientQuery(parsedUrl.query ?? {});
  const queryStringValue = queryString.stringify(sanitizedQuery);
  return parsedUrl.pathname + (queryStringValue ? "?" + queryStringValue : "");
}

function getCacheKey(req: express.Request): string {
  if (req.method === "POST") {
    const sanitizedBody = sanitizeClientQuery(req.body ?? {});
    const queryStringValue = queryString.stringify(sanitizedBody);
    return req.path + (queryStringValue ? "?" + queryStringValue : "");
  }

  return getUrlKey(req.originalUrl);
}

function createResponseUsingStorage(
  req: express.Request,
  res: express.Response,
  storage: storageTypes.Storage
): Promise<redis.CacheableResponse> {
  const source = req.method === "POST" ? req.body || {} : req.query;

  const deploymentKey: string = (source.deploymentKey || source.deployment_key || "") as string;
  const appVersion: string = (source.appVersion || source.app_version || "") as string;
  const packageHash: string = (source.packageHash || source.package_hash || "") as string;
  const labelField = source.label || source.previousLabel || source.previous_label;
  const label =
    typeof labelField === "string" && labelField
      ? labelField
      : req.method === "GET" && typeof req.query.label === "string"
      ? req.query.label
      : typeof source.label === "string"
      ? source.label
      : "";
  const isCompanion: string = (source.isCompanion || source.is_companion || "") as string;

  const updateRequest: UpdateCheckRequest = {
    deploymentKey,
    appVersion,
    packageHash,
    isCompanion: isCompanion && isCompanion.toLowerCase() === "true",
    label,
  };

  let originalAppVersion: string;

  // Make an exception to allow plain integer numbers e.g. "1", "2" etc.
  const isPlainIntegerNumber: boolean = /^\d+$/.test(updateRequest.appVersion);
  if (isPlainIntegerNumber) {
    originalAppVersion = updateRequest.appVersion;
    updateRequest.appVersion = originalAppVersion + ".0.0";
  }

  // Make an exception to allow missing patch versions e.g. "2.0" or "2.0-prerelease"
  const isMissingPatchVersion: boolean = /^\d+\.\d+([\+\-].*)?$/.test(updateRequest.appVersion);
  if (isMissingPatchVersion) {
    originalAppVersion = updateRequest.appVersion;
    const semverTagIndex = originalAppVersion.search(/[\+\-]/);
    if (semverTagIndex === -1) {
      updateRequest.appVersion += ".0";
    } else {
      updateRequest.appVersion = originalAppVersion.slice(0, semverTagIndex) + ".0" + originalAppVersion.slice(semverTagIndex);
    }
  }

  const normalizedRequest: UpdateCheckRequest = {
    ...updateRequest,
    label: typeof label === "string" ? label : undefined,
  };

  if (validationUtils.isValidUpdateCheckRequest(normalizedRequest)) {
    return storage.getPackageHistoryFromDeploymentKey(normalizedRequest.deploymentKey).then((packageHistory: storageTypes.Package[]) => {
      const updateObject: UpdateCheckCacheResponse = acquisitionUtils.getUpdatePackageInfo(packageHistory, normalizedRequest);
      if ((isMissingPatchVersion || isPlainIntegerNumber) && updateObject.originalPackage.appVersion === normalizedRequest.appVersion) {
        // Set the appVersion of the response to the original one with the missing patch version or plain number
        updateObject.originalPackage.appVersion = originalAppVersion;
        if (updateObject.rolloutPackage) {
          updateObject.rolloutPackage.appVersion = originalAppVersion;
        }
      }

      const cacheableResponse: redis.CacheableResponse = {
        statusCode: 200,
        body: updateObject,
      };

      return q(cacheableResponse);
    });
  } else {
    if (!validationUtils.isValidKeyField(updateRequest.deploymentKey)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key - please check that your app has been " +
        "configured correctly. To view available deployment keys, run 'code-push-standalone deployment ls <appName> -k'."
      );
    } else if (!validationUtils.isValidAppVersionField(updateRequest.appVersion)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a binary version that conforms to the semver standard (e.g. '1.0.0'). " +
        "The binary version is normally inferred from the App Store/Play Store version configured with your app."
      );
    } else {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key and provide a semver-compliant app version."
      );
    }

    return null;
  }
}

export function getHealthRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  router.get("/health", (req: express.Request, res: express.Response, next: (err?: any) => void): any => {
    storage
      .checkHealth()
      .then(() => {
        // code-push-server-standalone does not use redis, so we need to return true
        // It seems that microsoft use the RedisManager internally, but before they open-sourced it, they removed it
        return true; // redisManager.checkHealth();
      })
      .then(() => {
        res.status(200).send("Healthy");
      })
      .catch((error: Error) => errorUtils.sendUnknownError(res, error, next))
  });

  return router;
}

export function getAcquisitionRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  const updateCheck = function (newApi: boolean) {
    return function (req: express.Request, res: express.Response, next: (err?: any) => void) {
      const source = req.method === "POST" ? req.body || {} : req.query;
      const deploymentKey: string = String(source.deploymentKey || source.deployment_key || "");
      const clientUniqueId: string = String(source.clientUniqueId || source.client_unique_id || "");
      const key: string = redis.Utilities.getDeploymentKeyHash(deploymentKey);
      const url: string = getCacheKey(req);
      let fromCache: boolean = true;
      let redisError: Error;

      redisManager
        .getCachedResponse(key, url)
        .catch((error: Error) => {
          // Store the redis error to be thrown after we send response.
          redisError = error;
          return q<redis.CacheableResponse>(null);
        })
        .then((cachedResponse: redis.CacheableResponse) => {
          fromCache = !!cachedResponse;
          return cachedResponse || createResponseUsingStorage(req, res, storage);
        })
        .then((response: redis.CacheableResponse) => {
          if (!response) {
            return q<void>(null);
          }

          let giveRolloutPackage: boolean = false;
          const cachedResponseObject = <UpdateCheckCacheResponse>response.body;
          if (cachedResponseObject.rolloutPackage && clientUniqueId) {
            const releaseSpecificString: string =
              cachedResponseObject.rolloutPackage.label || cachedResponseObject.rolloutPackage.packageHash;
            giveRolloutPackage = rolloutSelector.isSelectedForRollout(
              clientUniqueId,
              cachedResponseObject.rollout,
              releaseSpecificString
            );
          }

          const updateCheckBody: { updateInfo: UpdateCheckResponse } = {
            updateInfo: giveRolloutPackage ? cachedResponseObject.rolloutPackage : cachedResponseObject.originalPackage,
          };

          // Change in new API
          updateCheckBody.updateInfo.target_binary_range = updateCheckBody.updateInfo.appVersion;

          res.locals.fromCache = fromCache;
          res.status(response.statusCode).send(newApi ? utils.convertObjectToSnakeCase(updateCheckBody) : updateCheckBody);

          // Update REDIS cache after sending the response so that we don't block the request.
          if (!fromCache) {
            return redisManager.setCachedResponse(key, url, response);
          }
        })
        .then(() => {
          if (redisError) {
            throw redisError;
          }
        })
        .catch((error: storageTypes.StorageError) => errorUtils.restErrorHandler(res, error, next));
    };
  };

  const reportStatusDeploy = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    const appVersion = req.body.appVersion || req.body.app_version;
    const previousDeploymentKey = req.body.previousDeploymentKey || req.body.previous_deployment_key || deploymentKey;
    const previousLabelOrAppVersion = req.body.previousLabelOrAppVersion || req.body.previous_label_or_app_version;
    const clientUniqueId = req.body.clientUniqueId || req.body.client_unique_id;

    if (!deploymentKey || !appVersion) {
      return errorUtils.sendMalformedRequestError(res, "A deploy status report must contain a valid appVersion and deploymentKey.");
    } else if (req.body.label) {
      if (!req.body.status) {
        return errorUtils.sendMalformedRequestError(res, "A deploy status report for a labelled package must contain a valid status.");
      } else if (!redis.Utilities.isValidDeploymentStatus(req.body.status)) {
        return errorUtils.sendMalformedRequestError(res, "Invalid status: " + req.body.status);
      }
    }

    const sdkVersion: string = restHeaders.getSdkVersion(req);
    if (semver.valid(sdkVersion) && semver.gte(sdkVersion, METRICS_BREAKING_VERSION)) {
      // If previousDeploymentKey not provided, assume it is the same deployment key.
      let redisUpdatePromise: Promise<void>;

      if (req.body.label && req.body.status === redis.DEPLOYMENT_FAILED) {
        redisUpdatePromise = redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status);
      } else {
        const labelOrAppVersion: string = req.body.label || appVersion;
        redisUpdatePromise = redisManager.recordUpdate(
          deploymentKey,
          labelOrAppVersion,
          previousDeploymentKey,
          previousLabelOrAppVersion
        );
      }

      redisUpdatePromise
        .then(() => {
          res.sendStatus(200);
          if (clientUniqueId) {
            redisManager.removeDeploymentKeyClientActiveLabel(previousDeploymentKey, clientUniqueId);
          }
        })
        .catch((error: any) => errorUtils.sendUnknownError(res, error, next));
    } else {
      if (!clientUniqueId) {
        return errorUtils.sendMalformedRequestError(
          res,
          "A deploy status report must contain a valid appVersion, clientUniqueId and deploymentKey."
        );
      }

      return redisManager
        .getCurrentActiveLabel(deploymentKey, clientUniqueId)
        .then((currentVersionLabel: string) => {
          if (req.body.label && req.body.label !== currentVersionLabel) {
            return redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status).then(() => {
              if (req.body.status === redis.DEPLOYMENT_SUCCEEDED) {
                return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, req.body.label, currentVersionLabel);
              }
            });
          } else if (!req.body.label && appVersion !== currentVersionLabel) {
            return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, appVersion, appVersion);
          }
        })
        .then(() => {
          res.sendStatus(200);
        })
        .catch((error: any) => errorUtils.sendUnknownError(res, error, next));
    }
  };

  const reportStatusDownload = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    if (!req.body || !deploymentKey || !req.body.label) {
      return errorUtils.sendMalformedRequestError(
        res,
        "A download status report must contain a valid deploymentKey and package label."
      );
    }
    return redisManager
      .incrementLabelStatusCount(deploymentKey, req.body.label, redis.DOWNLOADED)
      .then(() => {
        res.sendStatus(200);
      })
      .catch((error: any) => errorUtils.sendUnknownError(res, error, next))
  };

  router.get("/updateCheck", updateCheck(false));
  router.post("/updateCheck", updateCheck(false));
  router.get("/v0.1/public/codepush/update_check", updateCheck(true));
  router.post("/v0.1/public/codepush/update_check", updateCheck(true));

  router.post("/reportStatus/deploy", reportStatusDeploy);
  router.post("/v0.1/public/codepush/report_status/deploy", reportStatusDeploy);

  router.post("/reportStatus/download", reportStatusDownload);
  router.post("/v0.1/public/codepush/report_status/download", reportStatusDownload);

  // General reportStatus endpoint - route to deploy by default for compatibility
  router.post("/reportStatus", reportStatusDeploy);

  // Storage endpoint for serving package blobs directly
  router.get("/storagev2/:blobId", (req: express.Request, res: express.Response, next: (err?: any) => void) => {
    const blobId = req.params.blobId;
    if (!blobId) {
      return errorUtils.sendMalformedRequestError(res, "Blob ID is required");
    }

    // Check if we're using JsonStorage (which stores blobs in memory)
    if ((storage as any).getBlobContent) {
      const blobContent = (storage as any).getBlobContent(blobId);
      if (blobContent) {
        res.send(blobContent);
      } else {
        errorUtils.sendNotFoundError(res, "Package not found");
      }
    } else {
      // For other storage types (like Azure), redirect to the blob URL
      storage
        .getBlobUrl(blobId)
        .then((blobUrl: string) => {
          res.redirect(302, blobUrl);
        })
        .catch((error: storageTypes.StorageError) => {
          if (error.code === storageTypes.ErrorCode.NotFound) {
            errorUtils.sendNotFoundError(res, "Package not found");
          } else {
            errorUtils.restErrorHandler(res, error, next);
          }
        });
    }
  });

  return router;
}
