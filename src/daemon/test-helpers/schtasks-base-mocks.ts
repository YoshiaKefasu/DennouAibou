import { setSchtasksTestDeps } from "../schtasks.js";
import { baseSchtasksTestDeps } from "./schtasks-fixtures.js";

// Inject the scheduler/port/process boundaries once for every schtasks suite.
// Suites layer their own spawn/sleep stubs on top via `setSchtasksTestDeps`.
setSchtasksTestDeps(baseSchtasksTestDeps());
