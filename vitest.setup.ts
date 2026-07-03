import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'

// Testing-library's default waitFor timeout is 1000ms, which is too tight for the heavier renderer
// e2e tests when the full suite runs in parallel under CPU load. Raise the async-util ceiling so
// those condition polls tolerate load spikes (a real never-satisfied condition still fails at the
// vitest testTimeout). Configuring via @testing-library/dom keeps this safe in the node project too.
configure({ asyncUtilTimeout: 5000 })
