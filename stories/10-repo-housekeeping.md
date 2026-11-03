# 10 · Repository housekeeping

Things that need the owner's go-ahead.

- **Inherited tags.** 24 tags from robertnisipeanu/idrive-apps
  (`waze-on-cluster@*`, `cluster-render@*`, `robertn_waze_cluster@*`) are
  still on GitHub; only the Store's Tags channel would ever use them. Remove:
  `git push origin --delete $(git tag -l 'waze-on-cluster@*' 'cluster-render@*' 'robertn_waze_cluster@*' | sed 's#^#refs/tags/#')`
- **Leave the fork network.** GitHub Support's virtual assistant ("Detach
  fork") keeps the repository, its URL and releases. Deleting and recreating
  it would also work but deletes the releases until they are published again.
- **Actions on push.** Test runs only start on push once Actions are enabled
  for this repository (Actions tab); Release runs by hand already.
- **Git history** still holds upstream's commits (and credit). A clean
  history would need a rewrite and a force push.
