package com.supervision.entity;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "sys_role")
public class Role extends BaseEntity {

    @Column(nullable = false, length = 50)
    private String name;

    @Column(nullable = false, length = 50)
    private String code;

    @Column(length = 500)
    private String description;

    @Column(length = 20)
    private String status;

    /** 该角色当前绑定的成员数量，查询时按 sys_user_role 实时统计填充，不落库 */
    @Transient
    private Integer userCount;
}
