import { runWithDisposableReviewDatabase } from "./disposable-review-database.mjs";

try {
  await runWithDisposableReviewDatabase(({ run, environment }) => {
    run("pnpm", ["--filter", "@workspace/db", "run", "push-force"], {
      env: environment,
    });
    run("pnpm", ["--filter", "@workspace/api-server", "run", "test:direct"], {
      env: environment,
    });
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}