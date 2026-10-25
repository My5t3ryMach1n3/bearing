shopper = person "Shopper"
basket = softwareSystem "Basket" {
  basketApi = container "Basket API" {
    basketService = component "Basket service"
  }
}
shopper -> basketApi "Adds items using"
