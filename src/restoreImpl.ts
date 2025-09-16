import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { Events, Inputs, Outputs, State } from "./constants";
import {
    IStateProvider,
    NullStateProvider,
    StateProvider
} from "./stateProvider";
import * as utils from "./utils/actionUtils";

export async function restoreImpl(
    stateProvider: IStateProvider,
    earlyExit?: boolean | undefined
): Promise<string | undefined> {
    let originalCwd: string | undefined;
    let targetCwd: string | undefined;
    
    try {
        if (!utils.isCacheFeatureAvailable()) {
            core.setOutput(Outputs.CacheHit, "false");
            return;
        }

        // Validate inputs, this can cause task failure
        if (!utils.isValidEvent()) {
            utils.logWarning(
                `Event Validation Error: The event type ${
                    process.env[Events.Key]
                } is not supported because it's not tied to a branch or tag ref.`
            );
            return;
        }

        // Check if ci_path is provided and change directory if needed
        const ciPath = core.getInput(Inputs.CiPath);
        if (ciPath) {
            originalCwd = process.cwd();
            targetCwd = ciPath;  // 记录目标目录
            try {
                process.chdir(ciPath);
                core.info(`Changed directory to: ${ciPath}`);
                
                // 设置环境变量，让 GitHub Actions 知道新的工作目录
                process.env.GITHUB_WORKSPACE = ciPath;
                core.info(`Set GITHUB_WORKSPACE to: ${ciPath}`);
            } catch (error) {
                utils.logWarning(`Failed to change directory to ${ciPath}: ${(error as Error).message}`);
                return;
            }
        }

        const primaryKey = core.getInput(Inputs.Key, { required: true });
        stateProvider.setState(State.CachePrimaryKey, primaryKey);

        const restoreKeys = utils.getInputAsArray(Inputs.RestoreKeys);
        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });

        // 不要转换路径为绝对路径，让 GitHub Actions 在正确目录下处理
        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );
        const failOnCacheMiss = utils.getInputAsBool(Inputs.FailOnCacheMiss);
        const lookupOnly = utils.getInputAsBool(Inputs.LookupOnly);

        const cacheKey = await cache.restoreCache(
            cachePaths,  // 使用原始相对路径
            primaryKey,
            restoreKeys,
            { lookupOnly: lookupOnly },
            enableCrossOsArchive
        );

        if (!cacheKey) {
            // `cache-hit` is intentionally not set to `false` here to preserve existing behavior
            // See https://github.com/actions/cache/issues/1466

            if (failOnCacheMiss) {
                throw new Error(
                    `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${primaryKey}`
                );
            }
            core.info(
                `Cache not found for input keys: ${[
                    primaryKey,
                    ...restoreKeys
                ].join(", ")}`
            );
            return;
        }

        // Store the matched cache key in states
        stateProvider.setState(State.CacheMatchedKey, cacheKey);

        const isExactKeyMatch = utils.isExactKeyMatch(
            core.getInput(Inputs.Key, { required: true }),
            cacheKey
        );

        core.setOutput(Outputs.CacheHit, isExactKeyMatch.toString());
        if (lookupOnly) {
            core.info(`Cache found and can be restored from key: ${cacheKey}`);
        } else {
            core.info(`Cache restored from key: ${cacheKey}`);
        }

        return cacheKey;
    } catch (error: unknown) {
        core.setFailed((error as Error).message);
        if (earlyExit) {
            process.exit(1);
        }
    } finally {
        // Restore to ci_path directory if it was specified, otherwise restore to original directory
        if (targetCwd) {
            // 如果指定了 ci_path，恢复到 ci_path 目录
            try {
                process.chdir(targetCwd);
                core.info(`Restored directory to: ${targetCwd}`);
            } catch (error) {
                utils.logWarning(`Failed to restore directory to ${targetCwd}: ${(error as Error).message}`);
            }
        } else if (originalCwd) {
            // 如果没有指定 ci_path 但改变了目录，恢复到原始目录
            try {
                process.chdir(originalCwd);
                core.info(`Restored directory to: ${originalCwd}`);
            } catch (error) {
                utils.logWarning(`Failed to restore directory to ${originalCwd}: ${(error as Error).message}`);
            }
        }
    }
}

async function run(
    stateProvider: IStateProvider,
    earlyExit: boolean | undefined
): Promise<void> {
    await restoreImpl(stateProvider, earlyExit);

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(0);
    }
}

export async function restoreOnlyRun(
    earlyExit?: boolean | undefined
): Promise<void> {
    await run(new NullStateProvider(), earlyExit);
}

export async function restoreRun(
    earlyExit?: boolean | undefined
): Promise<void> {
    await run(new StateProvider(), earlyExit);
}
