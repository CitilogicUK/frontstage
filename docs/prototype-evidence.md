# Frontstage prototype evidence

The AI App Governance Platform spec describes four phases. Frontstage demonstrates workflows from all four with synthetic data. Use the local reviewer profile for the demo and record the deployed evidence separately for each pilot gate.

## Demo walkthrough

| Workflow | What to verify |
| --- | --- |
| Register proportionately | Download a starter for software built with AI but with no runtime model, then register a proof of concept. Compare its path with a Tier 3 app that takes actions and requires human approval evidence. [Gateway demo](../README.md#gateway-demo) |
| Control runtime AI | Try a sandbox call before and after critical approval and activation. Check the policy block, successful call, permitted models, and key history. [Gateway browser test](../e2e/gateway.spec.ts) |
| Bring unregistered usage into Inventory | Upload the sample usage CSV, save the reconciliation, register the unmatched app, and recheck. The current and original views should show zero and three unmatched calls respectively. [Outside-gateway usage](../README.md#review-usage-outside-the-gateway) |
| Keep ownership and approvals current | Filter owner gaps, review a scheduled attestation, and export the audit chain. The 30-day ownership summary uses the first recorded Catalog observation and reports incomplete coverage. [Owner attestation](../README.md#owner-attestation) · [Portfolio reports](../README.md#portfolio-reports) |
| Correct a connector discrepancy | Activate an app with an unlisted read connector, sign in as its owner, and follow the private notification to correct the declaration. The app scorecard should pass the declared connections check after the edit. [Connector alert demo](../README.md#correct-a-connector-discrepancy-from-an-owner-notification) |
| Reuse a published app | Find the seeded warehouse app in Directory, request access, and record the owner decision. The destination is a synthetic URL and access fulfilment stays with the destination app. [App directory](../README.md#app-directory) |

## Evidence needed for a pilot

- **Foundation.** Configure target SSO and directory sync in a test tenancy, verify builder and reviewer access with managed identities, and check app ownership resolution for disabled users. Exercise the intake and review paths with representative builders to establish registration timing and satisfaction. [Deployment](../README.md#deployment-and-roadmap)
- **Gateway.** Exercise a live provider using approved synthetic prompts and isolated credentials. Capture added latency, failure behaviour, and key rotation or revocation in the intended deployment. Confirm regional hosting, provider retention, and incident ownership before handling company data. The demo uses simulation for repeatable policy checks. [Live OpenAI configuration](../README.md#live-openai-call)
- **Automation.** Select the ticketing system and hosted provider for the pilot, then verify their supported permissions and interfaces. The prototype supports linked tickets and copied review context, plus uploaded hosted inventory and outside-gateway usage reconciliations. Automatic ticket creation, provider controls, and bypass detection still require integration evidence. [Review evidence](../README.md#review-evidence) · [Hosted inventory](../README.md#reconcile-a-hosted-provider-inventory)
- **Scale.** Test the Directory decision flow with an actual destination access workflow and agree who fulfils requests. Validate co-ownership and retirement against the pilot organisation’s lifecycle policy. The prototype supports owner decisions, audit history and Engineering co-ownership. [Engineering co-ownership](../README.md#engineering-co-ownership) · [App directory](../README.md#app-directory)

## Metric scope

| Spec metric | What the prototype measures |
| --- | --- |
| Catalog coverage | Tracked GitHub discoveries with a valid, source-matched, non-retired record and current Catalog ownership divided by non-dismissed tracked discoveries. The registered share is shown separately. A pilot needs to establish coverage of sources beyond GitHub. |
| Gateway share | Estimated live gateway spend divided by that estimate plus manually supplied outside spend for the same window. A pilot measurement needs complete billing data for both amounts. |
| Orphaned apps | Current accountable-owner gaps first observed more than 30 days ago. The first observation depends on the Catalog check schedule and missing observations are reported separately. |
| Overdue reviews | Non-retired Tier 2 and Tier 3 apps with an overdue scheduled review or attestation divided by non-retired Tier 2 and Tier 3 apps. |
| Time to register | The opt-in local measure shows the median time to submit a successful Tier 1 form and its sample count over 30 UTC calendar days. Backstage Analytics also emits timing through successful save when an analytics destination is configured. |
| Time to decision | Median UTC weekdays from first pending Tier 3 submission to the first overall approval or request for changes. Pending decisions appear in the queue. |
| Builder satisfaction | The form emits an optional three-point response through Backstage Analytics after registration. Pilot reporting needs a baseline and response rate. |

The percentages and time targets in the spec are proposals. Collect representative pilot data before using them as launch criteria.
