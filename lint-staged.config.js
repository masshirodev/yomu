/**
 * What the pre-commit hook formats and lints, per staged file.
 *
 * The extension lists cover everything `yarn run lint` checks over the whole
 * tree, so a commit that passes the hook does not fail at push on formatting
 * alone. A list that has to match another list is only safe as the wider one.
 *
 * Code extensions get one key, not two: lint-staged runs different keys
 * concurrently, and `eslint --fix` and `prettier --write` both rewrite the
 * file. Under one key they run in order (Kumiko lost a commit to this).
 */

const CODE = '*.{js,cjs,mjs,ts,svelte}';
const TEXT = '*.{json,css,md,yml,yaml}';

const codeSteps = [];
if (!process.env.SKIP_LINT) codeSteps.push('eslint --fix --no-warn-ignored');
if (!process.env.SKIP_FORMAT) codeSteps.push('prettier --write');

const config = {};
if (codeSteps.length) config[CODE] = codeSteps;
if (!process.env.SKIP_FORMAT) config[TEXT] = 'prettier --write';

export default config;
