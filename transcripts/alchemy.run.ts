/**
 * The transcript archive: one private R2 bucket that holds the Claude and Codex
 * transcripts of every machine, and an account token that reaches only that
 * bucket's objects. `archive.ts` uploads and restores; `credentials.ts` turns
 * the token into S3 keys on each machine.
 *
 * State lives in the Cloudflare state store, so the Mac and the workbox see one
 * stack. Both resources are retained: destroying the stack keeps the
 * transcripts and the keys.
 *
 * Alchemy's Cloudflare OAuth has no API-token scope, so deploy with the `cf`
 * CLI's login, which has `account_api_tokens:create` (run any `cf` command
 * first to refresh it):
 *
 *   CLOUDFLARE_ACCOUNT_ID=<account> CLOUDFLARE_API_TOKEN=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/Library/Preferences/cloudflare/config/default.json", "utf8")).oauth_token)') bun run deploy
 */
import * as Alchemy from 'alchemy';
import * as Cloudflare from '@alchemy.run/cloudflare';
import { Effect } from 'effect';

import { BUCKET } from './bucket.ts';

export default Alchemy.Stack(
  'transcripts',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    // Standard class: a transcript is replaced each day it grows, and
    // InfrequentAccess bills 30 days for every object it replaces sooner.
    const bucket = yield* Cloudflare.R2.Bucket('Archive', { name: BUCKET });
    const token = yield* Cloudflare.ApiToken.AccountApiToken('Writer', {
      name: BUCKET,
      accountId,
      policies: [
        {
          effect: 'allow',
          permissionGroups: ['Workers R2 Storage Bucket Item Read', 'Workers R2 Storage Bucket Item Write'],
          resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${BUCKET}`]: '*' },
        },
      ],
    });
    return { bucket: bucket.bucketName, accountId, tokenId: token.tokenId };
  }).pipe(Alchemy.RemovalPolicy.retain()),
);
