resource "aws_lb" "basket_api" {
  name               = "basket-api"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
}

resource "aws_lb_target_group" "basket_api" {
  name        = "basket-api"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
}

resource "aws_ecs_cluster" "basket" {
  name = "basket"
}

resource "aws_ecs_task_definition" "basket_api" {
  family                   = "basket-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  container_definitions = jsonencode([
    {
      name         = "basket-api"
      image        = var.basket_api_image
      portMappings = [{ containerPort = 8080 }]
      environment  = [{ name = "DATABASE_HOST", value = aws_db_instance.basket.address }]
    }
  ])
}

resource "aws_ecs_service" "basket_api" {
  name            = "basket-api"
  cluster         = aws_ecs_cluster.basket.id
  task_definition = aws_ecs_task_definition.basket_api.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets = var.private_subnet_ids
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.basket_api.arn
    container_name   = "basket-api"
    container_port   = 8080
  }
}
