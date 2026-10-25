# Added by hand to cut basket read latency. The target has no cache.
resource "aws_elasticache_subnet_group" "basket" {
  name       = "basket-cache"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_cluster" "basket" {
  cluster_id        = "basket-cache"
  engine            = "redis"
  node_type         = "cache.t4g.micro"
  num_cache_nodes   = 1
  subnet_group_name = aws_elasticache_subnet_group.basket.name
}
