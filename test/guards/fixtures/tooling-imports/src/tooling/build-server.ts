import { readFileSync } from "node:fs";
import { rollup as build } from "rollup";
import { createApp } from "../server/app.ts";
import { appErrorSchema } from "../shared/errors.ts";
import { RETRY_MAX } from "../shared/defaults.ts";

export const parts = [readFileSync, build, createApp, appErrorSchema, RETRY_MAX];
