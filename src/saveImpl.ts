import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as path from "path";

import { Events, Inputs, State } from "./constants";
import {
    IStateProvider,
    NullStateProvider,
    StateProvider
} from "./stateProvider";
import * as utils from "./utils/actionUtils";

// Catch and log any unhandled exceptions.  These exceptions can leak out of the uploadChunk method in
// @actions/toolkit when a failed upload closes the file descriptor causing any in-process reads to
// throw an uncaught exception.  Instead of failing this action, just warn.
process.on("uncaughtException", e => utils.logWarning(e.message));

export async function saveImpl(
    stateProvider: IStateProvider
): Promise<number | void> {
    let cacheId = -1;
    let originalCwd: string | undefined;
    let targetCwd: string | undefined;
    
    try {
        if (!utils.isCacheFeatureAvailable()) {
            return;
        }

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

        // If restore has stored a primary key in state, reuse that
        // Else re-evaluate from inputs
        const primaryKey =
            stateProvider.getState(State.CachePrimaryKey) ||
            core.getInput(Inputs.Key);

        if (!primaryKey) {
            utils.logWarning(`Key is not specified.`);
            return;
        }

        // If matched restore key is same as primary key, then do not save cache
        // NO-OP in case of SaveOnly action
        const restoredKey = stateProvider.getCacheState();

        if (utils.isExactKeyMatch(primaryKey, restoredKey)) {
            core.info(
                `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
            );
            return;
        }

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });

        // 不要转换路径为绝对路径，让 GitHub Actions 在正确目录下处理
        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        cacheId = await cache.saveCache(
            cachePaths,  // 使用原始相对路径
            primaryKey,
            { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
            enableCrossOsArchive
        );

        if (cacheId != -1) {
            core.info(`Cache saved with key: ${primaryKey}`);
        }
    } catch (error: unknown) {
        utils.logWarning((error as Error).message);
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
    return cacheId;
}

export async function saveOnlyRun(
    earlyExit?: boolean | undefined
): Promise<void> {
    try {
        const cacheId = await saveImpl(new NullStateProvider());
        if (cacheId === -1) {
            core.warning(`Cache save failed.`);
        }
    } catch (err) {
        console.error(err);
        if (earlyExit) {
            process.exit(1);
        }
    }

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(0);
    }
}

export async function saveRun(earlyExit?: boolean | undefined): Promise<void> {
    try {
        await saveImpl(new StateProvider());
    } catch (err) {
        console.error(err);
        if (earlyExit) {
            process.exit(1);
        }
    }

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(0);
    }
}
