resource "aws_db_subnet_group" "basket" {
  name       = "basket"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "basket" {
  identifier                  = "basket"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  db_name                     = "basket"
  username                    = "basket"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.basket.name
  skip_final_snapshot         = true
}
