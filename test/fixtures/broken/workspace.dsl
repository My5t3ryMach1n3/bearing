workspace "Broken" {
  model {
    shopper = person "Shopper"
    shopper -> missing "Uses"
  }
}
