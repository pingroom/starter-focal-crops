# PingRoom focal crops

Ask a named editor for the rectangle containing an image's entire essential region. Code calculates the largest integer crop for each declared aspect ratio while preserving that rectangle. The output is JSON geometry for your existing image workflow. This starter does not fetch, inspect, render or edit an image.

## Try the offline demo

Choose **Use this template**, clone your repository, and use Node.js 22 or later:

```sh
npm ci
npm test
npm run demo
```

The demo uses the real pinned SDK with an in-memory transport. It shows feasible crops, complete infeasibility and Unknown without credentials or network calls. The supplied dimensions describe a harmless practice fixture, not an inspected photograph.

## Connect your workflow

```sh
cp examples/image.json image.json
cp config.example.json config.json
npm run preview
npm run connect
npm run inspect
```

Edit `image.json` before starting. Set a stable `cropId`, title and `image` with `id`, `label`, integer `width` and `height`. Map these values from your image pipeline's metadata output: for example, asset version `paper-shapes-v1`, width `1200`, height `800`. The program validates these declarations; it does not read or hash image bytes.

Use the same immutable image version, orientation and coordinate system throughout. Account for EXIF rotation upstream before recording dimensions. The editor must open that version in their usual image tool. Give targets unique IDs and positive integer `p` and `q` terms: `16:9` means width:height. Ratios are reduced by their greatest common divisor and targets sorted by ID; proportional ratios and array reordering preserve the source hash. Other changes to declared metadata invalidate saved state. Changes to image bytes alone cannot be detected.

`connect` prints installation and pairing links. Approve a standard private room containing the editor. Run `inspect`, verify the person in PingRoom, and copy their member UUID and a descriptive label into `config.json`. Names alone do not establish identity. Credentials remain in ignored `.pingroom/`.

For an existing connection, optionally copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. If either is supplied by the shell, both must come from the shell; partial pairs never borrow another source's credentials.

```sh
npm start
# Editor replies in PingRoom; then read that original Question:
npm start
npm run report
npm run export-analysis
npm run export
```

At most one direct text Question per session addresses the configured editor, with a 15-minute lifetime. Its prompt includes image identity, declared dimensions, all reduced ratios and the coordinate convention. No attachment is sent.

## Report the essential region

Reply `left,top,right,bottom`, for example `400,200,600,500`, or exactly `Unknown`. Mark the **entire essential region**, including every feature that must survive. Never shrink it to make a desired ratio feasible. Use Unknown when the image, dimensions or region cannot be established.

Coordinates are integer pixel edges: origin at the top left, x increases rightward and y downward. Right and bottom are exclusive. Thus `0,0,1,1` encloses the top-left pixel, and `0,0,1200,800` encloses the whole example image. The rectangle must have positive width and height and lie within the declared image.

Use comma-separated decimal integers without spaces, signs, decimals, exponents or leading zeros. Validation checks PingRoom's normalized text and cannot detect surrounding whitespace trimmed by the server. Unknown and an invalid rectangle are distinct outcomes; both withhold complete geometry.

## Geometry and results

For reduced ratio `p:q`, the largest crop has scale `t = min(floor(W/p), floor(H/q))` and dimensions `p*t` by `q*t`. Because coprime ratio terms force every exact integer crop to those multiples, its area `p*q*t²` is maximal at this scale. If `t` is zero, no positive integer crop exists. If this largest crop cannot contain the focal extent, no smaller crop of that ratio can contain it either.

Legal horizontal positions are `[max(0, right-cropWidth), min(left, W-cropWidth)]`, with analogous vertical bounds. Code chooses the integer position nearest the focal center, clamps to those bounds, and selects the lower integer on exact half-pixel ties. This minimizes squared center distance because the two axes are independent. No ratio approximation, resizing, padding or content detection is performed.

`report` saves private `.crops/report.json`. `export-analysis` writes `.crops/analysis.json` for a valid known rectangle, including infeasible targets and their reasons. `export` writes `.crops/proposal.json` only when **all** targets are feasible. Individual feasible results remain diagnostic if another target fails; there is no partial usable proposal.

Artifacts include canonical metadata, rectangle, source/policy hashes, attributed Question evidence and crop coordinates. `imageInspected: false` and `imageEdited: false` describe this program. Results depend on declared dimensions and the editor's region and do not establish aesthetic quality. Local hashes are bindings, not signatures. Review the geometry in your image tool before applying it; no downstream operation is included.

## Recovery and limits

For `create_unknown`, preserve state and inspect the original request:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

A lost response never triggers another POST. No match in a bounded recent search does not prove creation failed. Recover only the original Question. Expired, cancelled or invalid answers are retained without replacement. Resolve uncertain/pending operations before archiving `.crops/` for a new run. Resolve or revoke uncertain pairing in Connected Agents before archiving its pending record.

Run/recover exit codes: `0` complete analysis, including infeasibility; `2` Unknown/incomplete or a newly invalid, expired or cancelled answer; `3` ready/pending/interrupted; `4` uncertain creation; `1` setup, provenance or operational error. Offline status/report success exits `0`; inspect JSON status and `analysis.feasible`.

Limits: dimensions and ratio terms 1–10000; 1–8 targets; title/image label 40 UTF-16 units; image ID 24 and target IDs 16 characters. Metadata must be trimmed, well-formed single-line Unicode without control/format characters. Inputs are capped at 64 KiB, config 16 KiB, state 1 MiB and HTTP responses 512 KiB. Transport deadlines are five seconds.

Credentials, root inputs, state and exports are ignored by Git. Private files/directories use `0600`/`0700`, atomic writes and local locks for one-machine coordination. Remove a stale lock only after confirming its owning process stopped. SDK `0.7.1` is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. MIT licensed; CI tests Node.js 22 and 24 with mocks.
