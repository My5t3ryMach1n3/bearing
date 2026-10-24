# B-12 Extract the deployment view from Terraform

**Milestone:** M1 MVP (TypeScript) · Build loop  
**Labels:** area:extractor  
**Depends on:** B-04

Parse Terraform under `iac.terraform` into deployment nodes and compare them with the target deployment view. Kubernetes manifests follow later.

- [ ] Maps a fixed set of AWS resource types to deployment nodes, documented in a table
- [ ] Unknown resource types are reported, not silently dropped
- [ ] The seeded Redis branch in the fixture shows an added node
