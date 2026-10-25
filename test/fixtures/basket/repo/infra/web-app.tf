resource "aws_s3_bucket" "web_app" {
  bucket = "basket-web-app"
}

resource "aws_cloudfront_origin_access_control" "web_app" {
  name                              = "basket-web-app"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web_app" {
  enabled             = true
  default_root_object = "index.html"

  origin {
    origin_id                = "web-app"
    domain_name              = aws_s3_bucket.web_app.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web_app.id
  }

  default_cache_behavior {
    target_origin_id       = "web-app"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
