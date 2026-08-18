const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = Number(process.env.GITHUB_REQUEST_RETRY_DELAY_MS ?? 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeBody(text, maxLength = 240) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return 'empty response body';
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function headers(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'crawler-ci-recovery',
    ...extra,
  };
}

export async function request(token, path, options = {}) {
  const method = options.method || 'GET';
  const canRetry = method === 'GET';
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
    }
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: headers(token, options.headers),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let data = null;
    let parseError = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        parseError = error;
      }
    }
    if (!response.ok) {
      const error = new Error(
        `GitHub ${method} ${path} failed (${response.status}): ${data?.message || summarizeBody(text)}`,
      );
      error.status = response.status;
      error.data = data;
      error.headers = response.headers;
      error.body = text;
      if (parseError) {
        error.cause = parseError;
      }
      if (canRetry && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRY_ATTEMPTS) {
        // Retryable transient error — next iteration backs off and retries.
        continue;
      }
      throw error;
    }
    if (parseError) {
      const error = new Error(
        `GitHub ${method} ${path} returned non-JSON success (${response.status}): ${summarizeBody(text)}`,
      );
      error.status = response.status;
      error.data = null;
      error.headers = response.headers;
      error.body = text;
      error.cause = parseError;
      throw error;
    }
    return { data, headers: response.headers, status: response.status };
  }
  // Unreachable: every loop iteration either returns, throws, or continues to the
  // next attempt; the final attempt always throws or returns directly.
  throw new Error(`GitHub ${method} ${path}: exhausted all retry attempts`);
}

export async function paginate(token, path) {
  const separator = path.includes('?') ? '&' : '?';
  const results = [];
  let page = 1;
  while (true) {
    const response = await request(token, `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(response.data)) {
      throw new Error(`Expected paginated array from ${path}`);
    }
    results.push(...response.data);
    if (response.data.length < 100) {
      return results;
    }
    page += 1;
  }
}

export async function graphql(token, query, variables = {}) {
  const canRetry = query.trimStart().startsWith('query');
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
    }
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) {
      if (canRetry && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRY_ATTEMPTS) {
        continue;
      }
      throw new Error(
        `GitHub GraphQL failed: ${payload.errors?.map((error) => error.message).join('; ') || response.status}`,
      );
    }
    return payload.data;
  }
  throw new Error('GitHub GraphQL: exhausted all retry attempts');
}

export async function listReviewThreads(token, owner, repo, number, graphqlFn = graphql) {
  const query = `
    query(
      $owner: String!,
      $repo: String!,
      $number: Int!,
      $threadCursor: String,
      $reviewCursor: String,
      $includeThreads: Boolean!,
      $includeReviews: Boolean!
    ) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          assignees(first: 50) { nodes { id login } }
          reviewThreads(first: 100, after: $threadCursor) @include(if: $includeThreads) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 100) {
                nodes {
                  id
                  body
                  url
                  author { login }
                  authorAssociation
                }
              }
            }
          }
          reviews(first: 100, after: $reviewCursor) @include(if: $includeReviews) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              body
              state
              submittedAt
              author { login }
              commit { oid }
              comments(first: 1) {
                nodes { body }
              }
            }
          }
        }
      }
    }`;
  const threads = [];
  const reviews = [];
  let threadCursor = null;
  let reviewCursor = null;
  let includeThreads = true;
  let includeReviews = true;
  let pullRequest = null;
  do {
    const data = await graphqlFn(token, query, {
      owner,
      repo,
      number,
      threadCursor,
      reviewCursor,
      includeThreads,
      includeReviews,
    });
    const page = data.repository?.pullRequest;
    if (!page) {
      throw new Error(`PR #${number} was not found`);
    }
    pullRequest = page;
    if (includeThreads) {
      threads.push(...(page.reviewThreads?.nodes || []));
      includeThreads = page.reviewThreads?.pageInfo?.hasNextPage === true;
      threadCursor = includeThreads ? page.reviewThreads.pageInfo.endCursor : null;
    }
    if (includeReviews) {
      reviews.push(...(page.reviews?.nodes || []));
      includeReviews = page.reviews?.pageInfo?.hasNextPage === true;
      reviewCursor = includeReviews ? page.reviews.pageInfo.endCursor : null;
    }
  } while (includeThreads || includeReviews);
  return {
    id: pullRequest.id,
    assignees: pullRequest.assignees?.nodes || [],
    reviews,
    threads,
  };
}

export async function listClosingIssues(token, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              number
              title
              state
              labels(first: 100) { nodes { name } }
              repository { nameWithOwner }
            }
          }
        }
      }
    }`;
  const issues = [];
  let cursor = null;
  do {
    const data = await graphql(token, query, { owner, repo, number, cursor });
    const references = data.repository?.pullRequest?.closingIssuesReferences;
    issues.push(...(references?.nodes || []));
    cursor = references?.pageInfo?.hasNextPage ? references.pageInfo.endCursor : null;
  } while (cursor);
  return issues;
}
