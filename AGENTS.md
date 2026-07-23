# Cross-repository changes

- The backend repository (Rust multi-tenant headless CMS API) is located at `../moltcms`.
- The admin dashboard frontend repository is located at `../moltcms-dashboard`.
- The static site generation framework repository (`@moltcms/static`, Bun-based) is located at `../moltcms-static`.
- Terraform configuration is located at `../tf`.
- Kubernetes manifests are located at `../kubernetes_manifests`.

When a task requires changes in any of these repositories, create a Git worktree so as not to interfere with other work. Make the changes in that worktree, open a pull request, and then remove the entire local Git worktree directory and delete its associated local branch.
