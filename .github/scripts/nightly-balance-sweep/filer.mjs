import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import { fileNightlyBalanceIssue } from './filer-lib.mjs';

const result = await fileNightlyBalanceIssue({
  env: process.env,
  request,
  paginate,
  graphql,
});

process.stdout.write(
  `nightly-balance-filer status=${result.status} issue=#${result.issueNumber}\n`,
);
