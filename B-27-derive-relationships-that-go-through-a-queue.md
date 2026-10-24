# B-27 Derive relationships that go through a queue

**Milestone:** M2 Language adapters  
**Labels:** area:extractor  
**Depends on:** B-12, B-26

Relationships through SQS and similar aren't imports. Build them from Terraform (the queue plus each task role's IAM policy) and confirm them with messaging spans.

- [ ] `eventPublisher -> appointmentEvents -> eventConsumer` derived for the worked example
- [ ] Trace hooks inject and extract `traceparent` in message attributes by default, so one test yields one trace across the queue
- [ ] Trace path check (B-17) handles the async hop
