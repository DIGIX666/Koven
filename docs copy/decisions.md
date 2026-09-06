# Architecture decisions

Decisions are discussed and resolved in GitHub issues. Once accepted, their
outcome and rationale should be recorded here so the repository remains the
durable source of truth.

## Repository conventions

Files named `.gitkeep` are temporary placeholders used only so Git can track an
otherwise empty directory. A `.gitkeep` must be deleted as soon as a real file
is added to the same directory.

Pull requests targeting `main` must use a Conventional Commit-style title. The
accepted types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`,
`build`, `perf`, and `revert`, with an optional scope and breaking-change `!`.
