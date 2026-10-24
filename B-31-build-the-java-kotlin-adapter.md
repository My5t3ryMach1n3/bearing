# B-31 Build the Java/Kotlin adapter

**Milestone:** M2 Language adapters  
**Labels:** area:lang  
**Depends on:** B-26

One adapter for both, since Kotlin reuses the JVM tooling.

- [ ] Import extractor from compiled class dependencies (jdeps or equivalent), so Java and Kotlin share it
- [ ] Trace hook as a Java agent that rewrites bytecode for classes under component paths
- [ ] Tag carrier: a JUnit 5 tag or display name
- [ ] A small Spring Boot fixture passes all checks
