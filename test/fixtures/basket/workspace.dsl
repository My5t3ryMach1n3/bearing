workspace "Basket" {
  model {
    !include model.dsl
  }

  views {
    systemContext basket {
      include *
    }
  }
}
