import { defineConfig } from '@playwright/test';

// The port comes from the environment so the workstation CI runner (doc/CI.md)
// can run the suite beside a developer's own servers; the default is this
// checkout's (AGENTS.local.md).
const port = Number(process.env.YOMU_E2E_PORT ?? 42150);

export default defineConfig({
	testDir: 'tests',
	testMatch: '**/*.e2e.ts',
	// Stated rather than inherited: Playwright's default is half the cores
	// locally and one under CI, so the suite would interleave on one machine and
	// run serially on another (Kumiko learned this the hard way).
	workers: 2,
	// A loaded workstation (other agents' suites) makes 5 s expectations flaky
	// without anything being wrong (Kata c123). A passing test never waits.
	expect: { timeout: 15_000 },
	webServer: {
		command: `yarn run build && npx vite preview --port ${port} --strictPort`,
		port,
		reuseExistingServer: false,
		timeout: 180_000,
		// A database of its own under temp/, so the suite never reads or writes
		// the line store in data/, and no Lattice token, so nothing it does
		// reaches the real flashcards, hours or metrics.
		env: { YOMU_DB: 'temp/e2e/yomu.db', LATTICE_TOKEN: '' }
	},
	use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' }
});
