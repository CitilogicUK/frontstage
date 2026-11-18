# Building workspace screens

Start with `WorkspaceLayout`. It provides the page title, description, content width, and primary action placement. Backstage mounts `WorkspaceNavigation` once in `App.tsx`. Add destinations in `workspaceViews` and register their routes. The navigation entries are for destinations. Use the layout’s `action` slot for a screen-specific primary action. The inventory and catalog default to **Register app**.

The shared colors, spacing, and interaction states live in [governance.css](../../packages/app/src/governance.css). Extend shared styles when a pattern repeats.

## List screens

Use [CatalogPage.tsx](../../packages/app/src/CatalogPage.tsx) as the example.

1. Put `WorkspaceSearch`, filters, and results inside one `gov-panel`. Give search and every filter an accessible label. Pass the filtered total to `WorkspaceSearch`.
2. Use `WorkspaceFilterTabs` for mutually exclusive views with short labels. Use a select for a secondary filter. Keep the data, filtering logic, and URL parameters in the screen.
3. Wrap results in `governance-table`. Use a native table with column headings and matching `data-label` values on cells for the mobile layout. Use `WorkspaceRecordTitle` inside a link for a detail route or a button for a dialog.
4. Show loading with `role="status"`, failures with `role="alert"`, and no results with `WorkspaceEmptyState`. Offer a way to clear a filter when the filter caused the empty state.

## Form screens

Use the Register view in [GovernancePage.tsx](../../packages/app/src/GovernancePage.tsx) as the example.

1. Group related inputs in a `gov-fieldset` with a visible legend. Use `governance-fields` for fields that can sit side by side on desktop.
2. Label each input and explain conditional requirements near the affected fields. Keep the form in one column at phone width.
3. Put submit and cancel in `gov-form-actions` and use `gov-primary` for submit. During submission, disable the submit button and give it a progress label.
4. Show validation or submission errors with `role="alert"` and retain the entered values. Use `role="status"` for success after the server confirms the action.

## Review before merging

Run the workspace browser check after adding a route. Add its heading and navigation expectations to [workspace.spec.ts](../../e2e/workspace.spec.ts). The check runs both desktop and phone layouts and verifies one navigation menu, the active destination, and the absence of horizontal overflow.

```sh
yarn playwright install chromium
yarn test:e2e
```

Playwright starts the local Backstage server if one is unavailable. An existing server on port 3000 can be reused when it is running the development guest profile.

Use these screenshots as references for spacing, navigation, headers, search, and filters. The images show demo records and serve as visual references for review.

| Screen    | Desktop                          | Phone                          |
| --------- | -------------------------------- | ------------------------------ |
| Catalog   | [1440 px](catalog-desktop.png)   | [390 px](catalog-mobile.png)   |
| Inventory | [1440 px](inventory-desktop.png) | [390 px](inventory-mobile.png) |
